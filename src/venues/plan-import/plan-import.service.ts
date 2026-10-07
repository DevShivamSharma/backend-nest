import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import type { PlanTextReading } from '../../ai/plan-text-reader.service';
import { PlanTextReaderService } from '../../ai/plan-text-reader.service';
import { isPlanTextKind, ruleKind } from '../../ai/plan-texts';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../common/http/authenticated-request';
import {
  AnalysedText,
  decodeMapCells,
  DrawingAnalysis,
  DrawingAnalysisInput,
  DrawingAnalysisOutcome,
  runDrawingAnalysis,
  SheetAnalysis,
} from '../../integrations/drawings/drawing-analysis';
import { GroupChoice, OUTSIDE } from '../../integrations/drawings/grid-map';
import { planFormatOf } from '../../integrations/drawings/plan-source';
import { FLOOR_AREA_KINDS, FloorAreaKind, HallFloor, sameFloor } from '../floor/hall-floor';
import { HallEntity } from '../hall.entity';
import { HallsService } from '../halls.service';
import type { HallView } from '../venue.views';
import { floorDiff, FloorDiff } from './floor-diff';
import { emptyReviewState, HallReview, reviewImport, ReviewState, SheetReview } from './review';
import type { SheetParts } from './sheet-parts';

/** One uploaded plan being read, or read, for one venue. Kept in memory for a while. */
interface PlanImportJob {
  id: string;
  organisationId: string;
  venueId: string;
  fileName: string;
  startedAt: Date;
  status: 'running' | 'done' | 'failed';
  step: 'reading' | 'texts' | 'done';
  message: string | null;
  progress: { done: number; total: number } | null;
  analysis: DrawingAnalysis | null;
  readings: Map<string, PlanTextReading>;
  model: { used: boolean; name: string | null; note: string | null } | null;
  state: ReviewState;
  partsCache: Map<string, SheetParts>;
  /** Hall key -> what was saved for it, so a retried save never saves twice. */
  saved: Map<string, { hallId: string; floorHash: string }>;
}

export interface SheetPreview {
  page: number;
  format: SheetAnalysis['format'];
  rotation: number;
  warnings: string[];
  mapSource: SheetAnalysis['map']['source'];
  /** JPEG data URL, and where the map's (0, 0) and one map unit are on it. */
  preview: Omit<SheetAnalysis['preview'], 'jpeg'> & { url: string };
  /** Map units per map cell side is 1/sub. */
  sub: number;
  dimensions: SheetAnalysis['dimensions'];
}

export interface PlanImportJobView {
  id: string;
  fileName: string;
  status: PlanImportJob['status'];
  step: PlanImportJob['step'];
  message: string | null;
  progress: PlanImportJob['progress'];
  startedAt: string;
  /** Present once the plan is read: the sheets as pictures (sent once), and the review. */
  sheets: SheetPreview[] | null;
  skipped: DrawingAnalysis['skipped'];
  model: PlanImportJob['model'];
  review: SheetReview[] | null;
  saved: Array<{ key: string; hallId: string }>;
}

/** What the person changed on the review screen; each field replaces that part of the state. */
export interface ReviewPatch {
  calibrate?: { page: number; metresPerUnit: number | null; detail?: string };
  cuts?: { page: number; cuts: ReviewState['cuts'][number] };
  assign?: {
    page: number;
    part: number;
    hall: string | null;
    role: 'floor' | 'foyer' | 'circulation';
  };
  name?: { key: string; name: string };
  group?: { page: number; id: number; choice: GroupChoice | null };
  hole?: { key: string; choice: GroupChoice | null };
  text?: { page: number; index: number; kind: string | null };
  acknowledge?: { key: string; checks: string[] };
}

export interface CommitHall {
  key: string;
  name?: string;
  code?: string | null;
  level?: string | null;
  /** 'new', or the id of a hall of this venue to add the floor to as a new version. */
  target: string;
  acknowledge?: string[];
}

export interface CommitResult {
  key: string;
  status: 'created' | 'updated' | 'unchanged' | 'already-saved' | 'failed';
  hall: HallView | null;
  error: string | null;
  /** The saved floor, read back, equals the reviewed one. */
  verified: boolean;
}

/**
 * Imports halls from a drawing: a PDF (CAD export or scan, one or more pages), a DXF, or an
 * image, of one hall or several. Reading takes seconds of CPU per page, so it runs in a worker
 * thread, one file at a time, and the person polls. The person then reviews every detected
 * hall (boundaries, foyers, colours, texts, scale and checks) and saves halls one by one, a
 * selection, or all. The job stays for two hours.
 */
@Injectable()
export class PlanImportService {
  static readonly TIMEOUT_MS = 600_000;
  static readonly JOB_TTL_MS = 2 * 60 * 60_000;
  static readonly MAX_JOBS = 30;
  /** Largest plan file accepted (bytes). */
  static readonly MAX_FILE_BYTES = 60 * 1024 * 1024;

  private readonly logger = new Logger(PlanImportService.name);
  private readonly jobs = new Map<string, PlanImportJob>();
  private running = 0;
  /** The compiled worker (dist). Under ts-node or Jest there is none and the job runs inline. */
  private readonly workerFile = join(
    __dirname,
    '..',
    '..',
    'integrations',
    'drawings',
    'drawing-analysis.worker.js',
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly halls: HallsService,
    private readonly reader: PlanTextReaderService,
    private readonly audit: AuditService,
  ) {}

  async start(
    organisationId: string,
    venueId: string,
    file: { buffer: Buffer; originalname: string; size: number } | undefined,
    options: { instructions: string | null; readText: boolean },
  ): Promise<PlanImportJobView> {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a plan file to upload.');
    if (file.size > PlanImportService.MAX_FILE_BYTES) {
      throw new BadRequestException('The plan is larger than 60 MB.');
    }
    const data = new Uint8Array(file.buffer);
    const fileName = file.originalname.slice(0, 160);
    if (!planFormatOf(fileName, data)) {
      throw new BadRequestException(
        /\.dwg$/i.test(fileName)
          ? 'DWG files cannot be read directly. Save the drawing as DXF or PDF and upload that.'
          : 'Upload a PDF, DXF, PNG, JPG, WebP or TIFF plan.',
      );
    }
    await this.halls.getVenue(this.dataSource.manager, organisationId, venueId);
    this.sweep();
    if (this.running >= 1) {
      throw new HttpException(
        'Another plan is being read. Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const job: PlanImportJob = {
      id: randomUUID(),
      organisationId,
      venueId,
      fileName,
      startedAt: new Date(),
      status: 'running',
      step: 'reading',
      message: null,
      progress: null,
      analysis: null,
      readings: new Map(),
      model: null,
      state: emptyReviewState(),
      partsCache: new Map(),
      saved: new Map(),
    };
    this.jobs.set(job.id, job);
    this.running++;
    void this.run(
      job,
      { data, fileName, readScannedText: options.readText },
      options.instructions,
    ).finally(() => this.running--);
    return this.view(job, true);
  }

  get(
    organisationId: string,
    venueId: string,
    jobId: string,
    withSheets: boolean,
  ): PlanImportJobView {
    return this.view(this.job(organisationId, venueId, jobId), withSheets);
  }

  /** Applies one change from the review screen and returns the new review. */
  review(
    organisationId: string,
    venueId: string,
    jobId: string,
    patch: ReviewPatch,
  ): PlanImportJobView {
    const job = this.readyJob(organisationId, venueId, jobId);
    applyPatch(job, patch);
    return this.view(job, false);
  }

  /** The aligned difference between an existing hall's current floor and a reviewed hall. */
  async diff(
    organisationId: string,
    venueId: string,
    jobId: string,
    key: string,
    hallId: string,
  ): Promise<FloorDiff & { hallName: string; version: number }> {
    const job = this.readyJob(organisationId, venueId, jobId);
    const hall = this.findHall(job, key);
    const existing = await this.halls.getHall(this.dataSource.manager, organisationId, hallId);
    if (existing.venueId !== venueId)
      throw new BadRequestException('That hall is in another venue.');
    const current = await this.halls.currentFloor(this.dataSource.manager, existing);
    return {
      ...floorDiff(current, hall.floor),
      hallName: existing.name,
      version: existing.currentVersion,
    };
  }

  /**
   * Saves halls, each in its own transaction: one that fails does not stop the others, and a
   * retry of a saved hall returns what was saved instead of saving it again.
   */
  async commit(
    organisationId: string,
    venueId: string,
    jobId: string,
    halls: CommitHall[],
    actor: Actor,
  ): Promise<CommitResult[]> {
    const job = this.readyJob(organisationId, venueId, jobId);
    if (!halls.length) throw new BadRequestException('Choose at least one hall to save.');
    const keys = new Set<string>();
    for (const h of halls) {
      if (keys.has(h.key)) throw new BadRequestException('A hall is chosen twice.');
      keys.add(h.key);
      if (h.acknowledge?.length) {
        applyPatch(job, { acknowledge: { key: h.key, checks: h.acknowledge } });
      }
      if (h.name?.trim()) applyPatch(job, { name: { key: h.key, name: h.name.trim() } });
    }
    const results: CommitResult[] = [];
    for (const h of halls) {
      results.push(await this.commitOne(job, h, actor));
    }
    return results;
  }

  private async commitOne(
    job: PlanImportJob,
    input: CommitHall,
    actor: Actor,
  ): Promise<CommitResult> {
    const failed = (error: string): CommitResult => ({
      key: input.key,
      status: 'failed',
      hall: null,
      error,
      verified: false,
    });
    let hall: HallReview;
    try {
      hall = this.findHall(job, input.key);
    } catch (error) {
      return failed((error as Error).message);
    }
    const floorHash = hashFloor(hall.floor);
    const previous = job.saved.get(hall.key);
    if (previous && previous.floorHash === floorHash) {
      const saved = await this.dataSource
        .getRepository(HallEntity)
        .findOneBy({ id: previous.hallId });
      if (saved) {
        return {
          key: hall.key,
          status: 'already-saved',
          hall: (await this.halls.views(this.dataSource.manager, [saved]))[0],
          error: null,
          verified: sameFloor(
            await this.halls.currentFloor(this.dataSource.manager, saved),
            hall.floor,
          ),
        };
      }
    }
    if (!hall.saveable) {
      const open = hall.checks.filter((c) => c.blocking && !c.acknowledged);
      return failed(`Resolve or acknowledge first: ${open.map((c) => c.label).join('; ')}.`);
    }
    const name = (input.name ?? hall.name).trim();
    if (!name) return failed('Give the hall a name.');
    const acknowledged = hall.checks
      .filter((c) => c.acknowledged)
      .map((c) => ({ id: c.id, label: c.label, evidence: c.evidence }));
    const note = `Imported from ${job.fileName}, page ${hall.page}${acknowledged.length ? `; ${acknowledged.length} check(s) acknowledged` : ''}`;
    const source = { floor: hall.floor, source: 'drawing' as const, sourceRef: job.fileName, note };

    try {
      const outcome = await this.dataSource.transaction(async (em) => {
        await this.halls.getVenue(em, job.organisationId, job.venueId);
        if (input.target !== 'new') {
          const existing = await this.halls.getHall(em, job.organisationId, input.target, true);
          if (existing.venueId !== job.venueId)
            throw new BadRequestException('That hall is in another venue.');
          if (sameFloor(await this.halls.currentFloor(em, existing), hall.floor)) {
            return { entity: existing, status: 'unchanged' as const };
          }
          const version = await this.halls.addVersion(em, existing, source, actor);
          await this.record(em, 'hall.floor_imported', job, existing.id, actor, {
            name: existing.name,
            version,
            file: job.fileName,
            page: hall.page,
            acknowledged,
          });
          return { entity: existing, status: 'updated' as const };
        }
        const twin = await this.samePlacement(em, job, hall.floor);
        if (twin) {
          throw new ConflictException(
            `"${twin.name}" was already imported from the same place on this plan. Save as a new version of it instead.`,
          );
        }
        const created = await this.halls.insertHall(
          em,
          {
            organisationId: job.organisationId,
            venueId: job.venueId,
            name,
            code: input.code ?? null,
            level: input.level ?? null,
          },
          source,
          actor,
        );
        await this.record(em, 'hall.imported', job, created.id, actor, {
          name,
          system: 'drawing',
          file: job.fileName,
          page: hall.page,
          acknowledged,
        });
        return { entity: created, status: 'created' as const };
      });
      const reloaded = await this.halls.getHall(
        this.dataSource.manager,
        job.organisationId,
        outcome.entity.id,
      );
      const stored = await this.halls.currentFloor(this.dataSource.manager, reloaded);
      const verified = sameFloor(stored, hall.floor);
      if (!verified)
        this.logger.error(`Saved floor of hall ${reloaded.id} differs from the reviewed one`);
      job.saved.set(hall.key, { hallId: reloaded.id, floorHash });
      return {
        key: hall.key,
        status: outcome.status,
        hall: (await this.halls.views(this.dataSource.manager, [reloaded]))[0],
        error: null,
        verified,
      };
    } catch (error) {
      if (error instanceof HttpException) return failed(error.message);
      this.logger.error(`Saving imported hall failed: ${(error as Error).message}`);
      return failed('The hall could not be saved. Try again.');
    }
  }

  /** A hall of this venue whose current floor came from the same place of the same plan. */
  private async samePlacement(
    em: EntityManager,
    job: PlanImportJob,
    floor: HallFloor,
  ): Promise<HallEntity | null> {
    const p = floor.placement;
    if (!p) return null;
    const halls = await em.getRepository(HallEntity).findBy({ venueId: job.venueId });
    for (const h of halls) {
      const other = (await this.halls.currentFloor(em, h)).placement;
      if (
        other &&
        other.file === p.file &&
        other.page === p.page &&
        Math.abs(other.x - p.x) < 0.5 &&
        Math.abs(other.y - p.y) < 0.5
      ) {
        return h;
      }
    }
    return null;
  }

  // ---- the job ------------------------------------------------------------------------------

  private async run(
    job: PlanImportJob,
    input: DrawingAnalysisInput,
    instructions: string | null,
  ): Promise<void> {
    try {
      const outcome = existsSync(this.workerFile)
        ? await this.inWorker(input)
        : await runDrawingAnalysis(input);
      if (!outcome.ok) {
        job.status = 'failed';
        job.message =
          outcome.kind === 'unreadable'
            ? outcome.message
            : 'The plan could not be read. Try a PDF exported from CAD, or a clearer image.';
        if (outcome.kind === 'internal')
          this.logger.error(`Plan import failed: ${outcome.message}`);
        return;
      }
      job.analysis = outcome.analysis;
      job.step = 'texts';
      const { readings, model } = await this.readTexts(
        outcome.analysis,
        instructions,
        (done, total) => {
          job.progress = { done, total };
        },
      );
      job.readings = readings;
      job.model = model;
      job.step = 'done';
      job.status = 'done';
    } catch (error) {
      job.status = 'failed';
      job.message =
        error instanceof HttpException
          ? error.message
          : 'The plan could not be read. Try a PDF exported from CAD, or a clearer image.';
      this.logger.error(`Plan import failed: ${(error as Error).message}`);
    }
  }

  /**
   * What each text is. The model is asked only about texts that can matter: those on or near
   * floor, and legend rows. OCR scraps and the title block are not sent: asking about them
   * only costs minutes on a CPU.
   */
  private async readTexts(
    analysis: DrawingAnalysis,
    instructions: string | null,
    onProgress: (done: number, total: number) => void,
  ): Promise<{
    readings: Map<string, PlanTextReading>;
    model: NonNullable<PlanImportJob['model']>;
  }> {
    const asked: string[] = [];
    for (const sheet of analysis.sheets) {
      const near = nearFloor(sheet);
      for (const t of sheet.texts) {
        if (ruleKind(t.text) !== undefined) {
          asked.push(t.text);
          continue;
        }
        if (!near(t) && !t.swatch) continue;
        if (
          t.source === 'file' ||
          ((t.text.match(/\p{L}/gu) ?? []).length >= 4 && t.confidence >= 60)
        ) {
          asked.push(t.text);
        }
      }
    }
    const result = await this.reader.classify(asked, { instructions, onProgress });
    for (const sheet of analysis.sheets) {
      for (const t of sheet.texts) {
        const key = t.text.replace(/\s+/g, ' ').trim();
        if (!result.readings.has(key))
          result.readings.set(key, { kind: 'none', by: 'default', review: false });
      }
    }
    return result;
  }

  private inWorker(input: DrawingAnalysisInput): Promise<DrawingAnalysisOutcome> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerFile, {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 3072 },
      });
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(
        () =>
          done(() =>
            reject(
              new HttpException(
                'The plan took too long to read. Try fewer pages, or a PDF or DXF instead of a scan.',
                HttpStatus.SERVICE_UNAVAILABLE,
              ),
            ),
          ),
        PlanImportService.TIMEOUT_MS,
      );
      worker.once('message', (outcome: DrawingAnalysisOutcome) => done(() => resolve(outcome)));
      worker.once('error', (error) => done(() => reject(error)));
      worker.once('exit', (code) =>
        done(() => reject(new Error(`The plan reader stopped (exit code ${code}).`))),
      );
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private job(organisationId: string, venueId: string, jobId: string): PlanImportJob {
    const job = this.jobs.get(jobId);
    // Another organisation's job is reported as missing, never as forbidden.
    if (!job || job.organisationId !== organisationId || job.venueId !== venueId) {
      throw new NotFoundException('This plan import has expired. Upload the plan again.');
    }
    return job;
  }

  private readyJob(organisationId: string, venueId: string, jobId: string): PlanImportJob {
    const job = this.job(organisationId, venueId, jobId);
    if (job.status === 'running') throw new BadRequestException('The plan is still being read.');
    if (job.status === 'failed' || !job.analysis) {
      throw new BadRequestException(job.message ?? 'The plan could not be read.');
    }
    return job;
  }

  private reviewOf(job: PlanImportJob): SheetReview[] {
    return reviewImport(job.analysis!, job.readings, job.state, job.partsCache);
  }

  private findHall(job: PlanImportJob, key: string): HallReview {
    for (const sheet of this.reviewOf(job)) {
      const hall = sheet.halls.find((h) => h.key === key);
      if (hall) return hall;
    }
    throw new NotFoundException('That hall is no longer on the review. Reload it.');
  }

  private view(job: PlanImportJob, withSheets: boolean): PlanImportJobView {
    const done = job.status === 'done' && job.analysis;
    return {
      id: job.id,
      fileName: job.fileName,
      status: job.status,
      step: job.step,
      message: job.message,
      progress: job.progress,
      startedAt: job.startedAt.toISOString(),
      sheets:
        done && withSheets
          ? job.analysis!.sheets.map((s) => ({
              page: s.page,
              format: s.format,
              rotation: s.rotation,
              warnings: s.warnings,
              mapSource: s.map.source,
              sub: s.map.sub,
              preview: {
                width: s.preview.width,
                height: s.preview.height,
                originX: s.preview.originX,
                originY: s.preview.originY,
                unitPxX: s.preview.unitPxX,
                unitPxY: s.preview.unitPxY,
                url: `data:image/jpeg;base64,${s.preview.jpeg}`,
              },
              dimensions: s.dimensions,
            }))
          : null,
      skipped: job.analysis?.skipped ?? [],
      model: job.model,
      review: done ? this.reviewOf(job) : null,
      saved: [...job.saved].map(([key, s]) => ({ key, hallId: s.hallId })),
    };
  }

  /** Forgets old jobs, and the oldest beyond the cap. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        job.status !== 'running' &&
        now - job.startedAt.getTime() > PlanImportService.JOB_TTL_MS
      ) {
        this.jobs.delete(id);
      }
    }
    while (this.jobs.size >= PlanImportService.MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((j) => j.status !== 'running');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  private record(
    em: EntityManager,
    action: string,
    job: PlanImportJob,
    hallId: string,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor,
        organisationId: job.organisationId,
        targetType: 'hall',
        targetId: hallId,
        metadata,
      },
      em,
    );
  }
}

/** Applies one review change, checking it against what the job holds. */
export function applyPatch(
  job: { analysis: DrawingAnalysis | null; state: ReviewState },
  patch: ReviewPatch,
): void {
  const state = job.state;
  const pages = new Set(job.analysis?.sheets.map((s) => s.page) ?? []);
  const page = (p: number) => {
    if (!pages.has(p)) throw new BadRequestException(`The plan has no page ${p}.`);
    return p;
  };
  if (patch.calibrate) {
    const p = page(patch.calibrate.page);
    const mpu = patch.calibrate.metresPerUnit;
    if (mpu === null) delete state.calibrations[p];
    else {
      if (!(mpu > 0 && mpu < 1000))
        throw new BadRequestException('The scale must be a positive number.');
      state.calibrations[p] = {
        metresPerUnit: mpu,
        detail: (patch.calibrate.detail ?? 'Set by you').slice(0, 200),
      };
    }
  }
  if (patch.cuts) {
    const p = page(patch.cuts.page);
    if (patch.cuts.cuts.length > 50) throw new BadRequestException('At most 50 cuts per page.');
    for (const c of patch.cuts.cuts) {
      if (![c.x, c.y, c.width, c.height].every(Number.isFinite) || c.width <= 0 || c.height <= 0) {
        throw new BadRequestException('A cut needs a position and a size.');
      }
    }
    state.cuts[p] = patch.cuts.cuts;
    // Part ids change with the cuts: earlier part decisions on this page no longer apply.
    delete state.overrides.assign[p];
  }
  if (patch.assign) {
    const p = page(patch.assign.page);
    if (!['floor', 'foyer', 'circulation'].includes(patch.assign.role)) {
      throw new BadRequestException('Unknown part role.');
    }
    if (patch.assign.hall !== null && !/^[\w:-]{1,40}$/.test(patch.assign.hall)) {
      throw new BadRequestException('Unknown hall.');
    }
    (state.overrides.assign[p] ??= {})[patch.assign.part] = {
      hall: patch.assign.hall,
      role: patch.assign.role,
    };
  }
  if (patch.name) {
    state.overrides.names[patch.name.key] = patch.name.name.trim().slice(0, 120);
  }
  if (patch.group) {
    const p = page(patch.group.page);
    const k = `${p}:${patch.group.id}`;
    if (patch.group.choice === null) delete state.groups[k];
    else {
      checkChoice(patch.group.choice);
      state.groups[k] = patch.group.choice;
    }
  }
  if (patch.hole) {
    if (patch.hole.choice === null) delete state.holes[patch.hole.key];
    else {
      checkChoice(patch.hole.choice);
      state.holes[patch.hole.key] = patch.hole.choice;
    }
  }
  if (patch.text) {
    const p = page(patch.text.page);
    const k = `${p}:${patch.text.index}`;
    if (patch.text.kind === null) delete state.texts[k];
    else {
      if (!isPlanTextKind(patch.text.kind))
        throw new BadRequestException(`"${patch.text.kind}" is not a kind of text.`);
      state.texts[k] = patch.text.kind;
    }
  }
  if (patch.acknowledge) {
    state.acks[patch.acknowledge.key] = [
      ...new Set(patch.acknowledge.checks.map((c) => c.slice(0, 60))),
    ];
  }
}

function checkChoice(choice: string): void {
  if (choice !== 'floor' && !FLOOR_AREA_KINDS.includes(choice as FloorAreaKind)) {
    throw new BadRequestException(`"${choice}" is not a kind of area.`);
  }
}

function hashFloor(floor: HallFloor): string {
  return createHash('sha256').update(JSON.stringify(floor)).digest('hex');
}

/** Texts this far from any floor are off the plan (title block, notes, streets). Map units. */
const NEAR_FLOOR = 10;

/** Whether a text lies on or within `NEAR_FLOOR` units of the sheet's floor. */
function nearFloor(sheet: SheetAnalysis): (t: AnalysedText) => boolean {
  const { cols, rows, sub } = sheet.map;
  const cells = decodeMapCells(sheet.map);
  const w = Math.ceil(cols / sub);
  const h = Math.ceil(rows / sub);
  const floor = new Uint8Array(w * h);
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] === OUTSIDE) continue;
    floor[Math.floor(Math.floor(k / cols) / sub) * w + Math.floor((k % cols) / sub)] = 1;
  }
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!floor[y * w + x]) continue;
      for (let yy = Math.max(0, y - NEAR_FLOOR); yy <= Math.min(h - 1, y + NEAR_FLOOR); yy++) {
        near.fill(
          1,
          yy * w + Math.max(0, x - NEAR_FLOOR),
          yy * w + Math.min(w, x + NEAR_FLOOR + 1),
        );
      }
    }
  }
  return (t) => {
    const x = Math.floor(t.x + t.width / 2);
    const y = Math.floor(t.y + t.height / 2);
    if (x < -NEAR_FLOOR || y < -NEAR_FLOOR || x >= w + NEAR_FLOOR || y >= h + NEAR_FLOOR)
      return false;
    if (x < 0 || y < 0 || x >= w || y >= h) return true;
    return near[y * w + x] === 1;
  };
}
