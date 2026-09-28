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

import { runImport, type PdfImportOutcome } from './pdf-import.job';
import type { ExtractionResult } from './stall-extraction';

/**
 * Runs a PDF import off the request thread. Reading and tracing a full hall plan is several
 * seconds of CPU; in a worker thread it cannot stall other API calls, and a runaway file is
 * cut off by the time and memory limits. Nothing is written to the database: the result is a
 * proposal the planner reviews before anything is saved.
 */
@Injectable()
export class PdfImportService {
  static readonly TIMEOUT_MS = 90_000;
  /** One at a time: a full hall plan needs a few hundred MB while it is read. */
  static readonly MAX_PARALLEL = 1;

  private readonly logger = new Logger(PdfImportService.name);
  private running = 0;
  /** The compiled worker (dist). Under ts-node / Jest there is none and the job runs inline. */
  private readonly workerFile = join(__dirname, 'pdf-import.worker.js');

  async extract(data: Uint8Array, page: number): Promise<ExtractionResult> {
    if (this.running >= PdfImportService.MAX_PARALLEL) {
      throw new HttpException('Another plan is being imported. Try again in a moment.', 429);
    }
    this.running++;
    try {
      const outcome = existsSync(this.workerFile)
        ? await this.inWorker(data, page)
        : await runImport({ data, page });
      if (outcome.ok) return outcome.result;
      if (outcome.kind === 'unreadable') throw new BadRequestException(outcome.message);
      if (outcome.kind === 'unsupported') throw new UnprocessableEntityException(outcome.message);
      throw new Error(outcome.message);
    } finally {
      this.running--;
    }
  }

  private inWorker(data: Uint8Array, page: number): Promise<PdfImportOutcome> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerFile, {
        workerData: { data, page },
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
        PdfImportService.TIMEOUT_MS,
      );
      worker.once('message', (outcome: PdfImportOutcome) => done(() => resolve(outcome)));
      worker.once('error', (e) => {
        this.logger.error(`PDF import worker failed: ${e.message}`);
        done(() => reject(e));
      });
      worker.once('exit', (code) =>
        done(() => reject(new Error(`PDF import worker exited with code ${code}`))),
      );
    });
  }
}
