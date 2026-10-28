import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';

import { runDrawingJob, type DrawingJob, type DrawingOutcome } from './drawing-import.job';
import type { HallStalls } from './hall-match';
import type { OverlayImage } from './overlay-image';
import type { ExtractionResult } from './stall-extraction';

/**
 * Reads CAD plan PDFs off the request thread. Reading and tracing a full hall plan is several
 * seconds of CPU; in a worker thread it cannot stall other API calls, and a runaway file is cut
 * off by the time and memory limits. Nothing is written: the stalls are a proposal the planner
 * reviews, and its rule-checked save is what changes a plan.
 */
@Injectable()
export class DrawingImportService {
  static readonly TIMEOUT_MS = 90_000;
  /** One at a time: a full hall plan needs a few hundred MB while it is read. */
  static readonly MAX_PARALLEL = 1;

  private readonly logger = new Logger(DrawingImportService.name);
  private running = 0;
  /** The compiled worker (dist). Under ts-node / Jest there is none and the job runs inline. */
  private readonly workerFile = join(__dirname, 'drawing-import.worker.js');

  async stalls(data: Uint8Array, page: number): Promise<ExtractionResult> {
    const outcome = await this.run({ kind: 'stalls', data, page });
    if (outcome.ok && outcome.kind === 'stalls') return outcome.result;
    throw this.failure(outcome);
  }

  /** The stalls of one hall of the plan, with the picture of them over the drawing. */
  async hallStalls(
    data: Uint8Array,
    page: number,
    hall: { name: string; code: string | null },
  ): Promise<{ stalls: HallStalls; overlay: OverlayImage | null }> {
    const outcome = await this.run({ kind: 'stalls', data, page, hall });
    if (outcome.ok && outcome.kind === 'stalls' && outcome.hallStalls) {
      const overlay = outcome.overlay
        ? { ...outcome.overlay, jpeg: Buffer.from(outcome.overlay.jpeg) }
        : null;
      return { stalls: outcome.hallStalls, overlay };
    }
    throw this.failure(outcome);
  }

  async dxf(data: Uint8Array, page: number): Promise<string> {
    const outcome = await this.run({ kind: 'dxf', data, page });
    if (outcome.ok && outcome.kind === 'dxf') return outcome.dxf;
    throw this.failure(outcome);
  }

  private async run(job: DrawingJob): Promise<DrawingOutcome> {
    if (this.running >= DrawingImportService.MAX_PARALLEL) {
      throw new HttpException('Another plan is being read. Try again in a moment.', 429);
    }
    this.running++;
    try {
      return existsSync(this.workerFile) ? await this.inWorker(job) : await runDrawingJob(job);
    } finally {
      this.running--;
    }
  }

  private failure(outcome: DrawingOutcome): Error {
    if (outcome.ok) return new Error('Unexpected outcome');
    if (outcome.kind === 'unreadable') return new BadRequestException(outcome.message);
    if (outcome.kind === 'unsupported') return new UnprocessableEntityException(outcome.message);
    this.logger.error(`Plan read failed: ${outcome.message}`);
    return new Error(outcome.message);
  }

  private inWorker(job: DrawingJob): Promise<DrawingOutcome> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerFile, {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
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
              new ServiceUnavailableException(
                'The plan took too long to read. Try a simpler PDF or one page.',
              ),
            ),
          ),
        DrawingImportService.TIMEOUT_MS,
      );
      worker.once('message', (outcome: DrawingOutcome) => done(() => resolve(outcome)));
      worker.once('error', (e) => {
        this.logger.error(`Plan reader worker failed: ${e.message}`);
        done(() => reject(e));
      });
      worker.once('exit', (code) =>
        done(() => reject(new Error(`Plan reader worker exited with code ${code}`))),
      );
    });
  }
}
