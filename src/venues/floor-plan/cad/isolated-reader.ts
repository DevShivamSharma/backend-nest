import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CadDrawing } from './cad-drawing';

export function readIsolatedPdfDrawing(data: Uint8Array, page: number): Promise<CadDrawing> {
  return new Promise((resolve, reject) => {
    const ts = __filename.endsWith('.ts');
    const worker = new Worker(join(__dirname, `reader.worker.${ts ? 'ts' : 'js'}`), {
      workerData: { data, page },
      ...(ts ? { execArgv: ['-r', 'ts-node/register/transpile-only'] } : {}),
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let finished = false;
    const finish = (error?: Error, drawing?: CadDrawing) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(drawing!);
    };
    const timeout = setTimeout(() => finish(new Error('CAD reading exceeded 60 seconds')), 60_000);
    worker.once('message', (result: { drawing?: CadDrawing; error?: string }) => {
      finish(
        result.drawing ? undefined : new Error(result.error ?? 'CAD reader returned no drawing'),
        result.drawing,
      );
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', () => {
      if (!finished) finish(new Error('CAD reader exited without a drawing'));
    });
  });
}
