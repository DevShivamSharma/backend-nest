import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import type { HallImportResult } from './hall-analysis';
import { runHallImport, type HallImportOutcome, type HallPlanFormat } from './hall-import.job';

/**
 * Analyses an uploaded hall plan off the request thread, like the PDF stall import: reading a
 * 60 MB DXF is seconds of CPU, which must not stall other API calls, and a runaway file is cut
 * off by the time and memory limits. Nothing is written: the result is a proposal the planner
 * reviews, then saves through POST /api/halls.
 */
@Injectable()
export class HallImportService {
  static readonly TIMEOUT_MS = 120_000;
  static readonly MAX_PARALLEL = 1;
  private readonly logger = new Logger(HallImportService.name);
  private running = 0;
  /** The compiled worker (dist). Under ts-node / Jest there is none and the job runs inline. */
  private readonly workerFile = join(__dirname, 'hall-import.worker.js');

  async analyse(data: Uint8Array, format: HallPlanFormat, fileName: string): Promise<HallImportResult> {
    if (this.running >= HallImportService.MAX_PARALLEL) {
      throw new HttpException('Another plan is being analysed. Try again in a moment.', 429);
    }
    this.running++;
    try {
      const job = { data, format, fileName };
      const outcome = existsSync(this.workerFile) ? await this.inWorker(job) : await runHallImport(job);
      if (outcome.ok) return outcome.result;
      if (outcome.kind === 'unreadable') throw new BadRequestException(outcome.message);
      throw new Error(outcome.message);
    } finally {
      this.running--;
    }
  }

  private inWorker(job: { data: Uint8Array; format: HallPlanFormat; fileName: string }): Promise<HallImportOutcome> {
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
                'The plan took too long to analyse. Try a DXF of just this hall.',
              ),
            ),
          ),
        HallImportService.TIMEOUT_MS,
      );
      worker.once('message', (outcome: HallImportOutcome) => done(() => resolve(outcome)));
      worker.once('error', (e) => {
        this.logger.error(`Hall import worker failed: ${e.message}`);
        done(() => reject(e));
      });
      worker.once('exit', (code) =>
        done(() => reject(new Error(`Hall import worker exited with code ${code}`))),
      );
    });
  }
}
