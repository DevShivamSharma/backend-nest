import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { FloorPlanImportEntity } from './plan-import.entity';
import { HallsService } from '../halls.service';
import { HallEntity } from '../hall.entity';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../common/http/authenticated-request';
import { editSchema, commitSchema, parse } from './validation';
import { exportConfig, floorDiff, hallKey, reviewHall } from './review';
import type { CommitResult, PlanView } from './plan.types';

export const PLAN_READER_VERSION = 'main-cad-3';
@Injectable()
export class FloorPlanService implements OnModuleDestroy {
  private workers = new Set<Worker>();
  private readonly logger = new Logger(FloorPlanService.name);
  constructor(
    @InjectDataSource() private db: DataSource,
    private halls: HallsService,
    private audit: AuditService,
  ) {}
  onModuleDestroy() {
    for (const worker of this.workers) void worker.terminate();
  }
  async upload(
    org: string,
    venue: string,
    file: { buffer: Buffer; originalname: string },
    fresh = false,
  ) {
    await this.halls.getVenue(this.db.manager, org, venue);
    if (
      !file?.buffer?.length ||
      file.buffer.length > 20 * 1024 * 1024 ||
      !/\.(pdf|png|jpe?g|dxf)$/i.test(file.originalname)
    )
      throw new BadRequestException('Choose a PDF, PNG, JPEG or ASCII DXF, up to 20 MB.');
    const repo = this.db.getRepository(FloorPlanImportEntity),
      fileHash = createHash('sha256').update(file.buffer).digest('hex');
    let previous = await repo.findOne({
      where: { organisationId: org, venueId: venue, fileHash },
      order: { createdAt: 'DESC' },
    });
    if (previous && !fresh) previous = await this.document(org, venue, previous.id);
    if (
      !fresh &&
      previous &&
      previous.status !== 'failed' &&
      (previous.readerVersion === PLAN_READER_VERSION ||
        Object.keys(previous.committed).length > 0) &&
      !(previous.status === 'reading' && Date.now() - previous.updatedAt.getTime() > 10 * 60_000)
    )
      return { id: previous.id };
    if (this.workers.size >= 2)
      throw new ConflictException('Two plans are being read. Try again when one finishes.');
    const doc = await repo.save(
      repo.create({
        organisationId: org,
        venueId: venue,
        fileHash,
        readerVersion: PLAN_READER_VERSION,
        fileName: file.originalname.slice(0, 200),
        status: 'reading',
        error: null,
        revision: 1,
        pages: [],
        committed: {},
      }),
    );
    const ts = __filename.endsWith('.ts');
    const worker = new Worker(join(__dirname, `reader.worker.${ts ? 'ts' : 'js'}`), {
      workerData: { data: file.buffer, fileName: doc.fileName },
      ...(ts ? { execArgv: ['-r', 'ts-node/register'] } : {}),
    });
    this.workers.add(worker);
    let settled = false;
    let extracted: FloorPlanImportEntity['pages'] = [];
    let progress = Promise.resolve();
    const finish = async (result: { pages?: FloorPlanImportEntity['pages']; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.workers.delete(worker);
      await worker.terminate();
      try {
        await progress;
        const pages = result.pages?.length ? result.pages : extracted;
        if (result.error && pages.length)
          pages[0].warnings.push(
            `Reading stopped early: ${result.error} Completed pages remain available; upload the remaining pages separately.`,
          );
        await repo.update(doc.id, {
          status: result.error && !pages.length ? 'failed' : 'ready',
          error: pages.length ? null : (result.error ?? null),
          pages,
        });
      } catch (error) {
        this.logger.error('Could not persist floor-plan analysis', error);
      }
    };
    const timeout = setTimeout(
      () =>
        void finish({
          error: 'Reading exceeded five minutes. Split or simplify the document and retry.',
        }),
      5 * 60_000,
    );
    worker.on('message', (result) => {
      if (settled) return;
      if (result.page) {
        extracted = [
          ...extracted.filter((page) => page.number !== result.page.number),
          result.page,
        ].sort((a, b) => a.number - b.number);
        const pages = extracted;
        progress = progress
          .then(async () => {
            await repo.update(doc.id, { pages });
          })
          .catch((error) => this.logger.warn(`Could not store reader progress: ${error.message}`));
      } else void finish(result);
    });
    worker.once('error', (error) => void finish({ error: error.message }));
    worker.once('exit', (code) => {
      if (!settled) void finish({ error: `Plan reader stopped (${code}). Upload again.` });
    });
    return { id: doc.id };
  }
  async document(
    org: string,
    venue: string,
    id: string,
    em = this.db.manager,
    lock = false,
  ): Promise<FloorPlanImportEntity> {
    if (!lock)
      return this.db.transaction((manager) => this.document(org, venue, id, manager, true));
    const row = await em.getRepository(FloorPlanImportEntity).findOne({
      where: { id, organisationId: org, venueId: venue },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row) throw new NotFoundException('This import does not belong to this venue.');
    const savedIds = [...new Set(Object.values(row.committed))];
    if (savedIds.length) {
      // Import history outlives deleted halls. Only live halls count as saved; retaining
      // the review lets the user recreate a deleted hall without losing their corrections.
      // Hold the live rows through commit so a concurrent delete cannot invalidate a retry.
      const liveHalls = await em.getRepository(HallEntity).find({
        select: { id: true },
        where: { id: In(savedIds), organisationId: org, venueId: venue },
        lock: { mode: 'pessimistic_read' },
      });
      const liveIds = new Set(liveHalls.map((hall) => hall.id));
      const committed = Object.fromEntries(
        Object.entries(row.committed).filter(([, hallId]) => liveIds.has(hallId)),
      );
      if (Object.keys(committed).length !== Object.keys(row.committed).length) {
        row.committed = committed;
        // Geometry is unchanged, so the existing review revision remains valid.
        await em.getRepository(FloorPlanImportEntity).update(row.id, { committed });
      }
    }
    return row;
  }
  async view(org: string, venue: string, id: string): Promise<PlanView> {
    const doc = await this.document(org, venue, id);
    if (doc.status === 'reading' && Date.now() - doc.updatedAt.getTime() > 10 * 60_000) {
      doc.status = 'failed';
      doc.error = 'Reading was interrupted. Upload the file again.';
      await this.db.getRepository(FloorPlanImportEntity).save(doc);
    }
    const existing = await this.halls.listForVenue(org, venue);
    return {
      id: doc.id,
      fileName: doc.fileName,
      revision: doc.revision,
      status: doc.status,
      error: doc.error,
      pages: doc.pages,
      committed: doc.committed,
      halls: doc.pages.flatMap((page) =>
        page.regions
          .filter((r) => r.role === 'hall')
          .map((r) => ({
            ...reviewHall(id, doc.revision, page, r).review,
            savedHallId: doc.committed[hallKey(page.number, r.id)] ?? null,
            existing: existing.map((h) => ({ id: h.id, name: h.name, version: h.currentVersion })),
          })),
      ),
    };
  }
  async edit(org: string, venue: string, id: string, body: unknown) {
    const input = parse(editSchema, body);
    await this.db.transaction(async (em) => {
      const doc = await this.document(org, venue, id, em, true);
      if (doc.status !== 'ready' || doc.revision !== input.revision)
        throw new ConflictException('The review changed. Reload before editing.');
      const page = doc.pages.find((p) => p.number === input.page);
      if (!page) throw new NotFoundException('Page not found.');
      const ids = new Set(input.regions.map((r) => r.id));
      if (
        ids.size !== input.regions.length ||
        new Set(input.objects.map((o) => o.id)).size !== input.objects.length
      )
        throw new BadRequestException('Region and object IDs must be unique.');
      const hallIds = new Set(input.regions.filter((r) => r.role === 'hall').map((r) => r.id));
      if (
        input.regions.some((r) => r.hallIds.some((id) => !hallIds.has(id))) ||
        input.dimensions.some((d) => d.regionId !== null && !hallIds.has(d.regionId)) ||
        input.annotations?.some((a) => a.regionIds.some((id) => !ids.has(id)))
      )
        throw new BadRequestException('A foyer or dimension references a missing hall.');
      // Saved snapshots stay stable. Other pages can continue independently after a partial import.
      for (const saved of page.regions.filter((r) => doc.committed[hallKey(page.number, r.id)])) {
        const nextRegion = input.regions.find((r) => r.id === saved.id && r.role === 'hall');
        if (!nextRegion)
          throw new ConflictException('A saved hall cannot be removed from this review.');
        const before = reviewHall(id, doc.revision, page, saved).floor;
        const after = reviewHall(id, doc.revision, { ...page, ...input }, nextRegion).floor;
        const snapshot = (g: typeof before) =>
          g ? JSON.stringify({ ...g, geometry: { ...g.geometry, review: undefined } }) : '';
        if (snapshot(before) !== snapshot(after))
          throw new ConflictException(
            'This edit changes a saved hall or its shared foyer. Start a new import for that change.',
          );
      }
      const { revision, page: _, ...changes } = input;
      Object.assign(page, changes);
      doc.revision++;
      await em.save(doc);
    });
    return this.view(org, venue, id);
  }
  async preview(org: string, venue: string, id: string, key: string, target?: string) {
    const doc = await this.document(org, venue, id);
    const page = doc.pages.find((p) =>
      p.regions.some((r) => hallKey(p.number, r.id) === key && r.role === 'hall'),
    );
    const region = page?.regions.find((r) => hallKey(page.number, r.id) === key);
    if (!page || !region) throw new NotFoundException('Hall not found.');
    const result = reviewHall(id, doc.revision, page, region);
    let diff = null;
    if (target && result.floor) {
      const old = await this.halls.get(org, target);
      if (old.venueId !== venue) throw new BadRequestException('Choose a hall in this venue.');
      diff = floorDiff(old.floor, result.floor);
    }
    return {
      ...result,
      diff,
      config: result.floor ? exportConfig(region.name, result.floor) : null,
    };
  }
  async commit(
    org: string,
    venue: string,
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<CommitResult[]> {
    const input = parse(commitSchema, body),
      results: CommitResult[] = [];
    for (const selection of input.selections) {
      try {
        results.push(
          await this.db.transaction(async (em) => {
            const doc = await this.document(org, venue, id, em, true);
            if (doc.status !== 'ready' || doc.revision !== input.revision)
              throw new ConflictException('Review changed; reload before saving.');
            if (doc.committed[selection.key])
              return { key: selection.key, hallId: doc.committed[selection.key] };
            const page = doc.pages.find((p) =>
                p.regions.some(
                  (r) => r.role === 'hall' && hallKey(p.number, r.id) === selection.key,
                ),
              ),
              region = page?.regions.find((r) => hallKey(page.number, r.id) === selection.key);
            if (!page || !region) throw new BadRequestException('Hall not found.');
            const { review, floor } = reviewHall(
              id,
              doc.revision,
              page,
              region,
              selection.acknowledgements,
            );
            if (!review.ready || !floor)
              throw new BadRequestException(
                'Resolve blocking checks and explicitly acknowledge remaining warnings.',
              );
            // Serialize name creation with other floor-plan commits for the venue.
            await em.query('SELECT id FROM venues WHERE id = $1 FOR UPDATE', [venue]);
            const next = {
              floor,
              source: 'drawing' as const,
              sourceRef: `${id}:${selection.key}`,
              note: `Reviewed source: ${doc.fileName}`,
            };
            let hall,
              version = 1;
            if (selection.targetHallId) {
              hall = await this.halls.getHall(em, org, selection.targetHallId, true);
              if (hall.venueId !== venue || hall.currentVersion !== selection.expectedVersion)
                throw new ConflictException('The selected hall changed. Reload and compare again.');
              version = await this.halls.addVersion(em, hall, next, actor);
            } else
              hall = await this.halls.insertHall(
                em,
                { organisationId: org, venueId: venue, name: selection.name },
                next,
                actor,
              );
            doc.committed[selection.key] = hall.id;
            await em.save(doc);
            await this.audit.record(
              {
                action: 'hall.floor_imported',
                actor,
                organisationId: org,
                targetType: 'hall',
                targetId: hall.id,
                metadata: {
                  documentId: id,
                  key: selection.key,
                  revision: doc.revision,
                  acknowledgements: selection.acknowledgements,
                  version,
                },
              },
              em,
            );
            return { key: selection.key, hallId: hall.id, version };
          }),
        );
      } catch (error) {
        results.push({
          key: selection.key,
          error: error instanceof Error ? error.message : 'Could not save hall.',
        });
      }
    }
    return results;
  }
}
