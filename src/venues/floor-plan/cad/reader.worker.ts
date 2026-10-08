import { parentPort, workerData } from 'node:worker_threads';
import { readPdfDrawing } from './pdf-drawing';

// Keep the main-branch PDF.js reader in its own runtime. The image renderer uses a newer
// PDF.js version whose global fake-worker handler must not be shared with this reader.
void readPdfDrawing(new Uint8Array(workerData.data), workerData.page).then(
  (drawing) => parentPort?.postMessage({ drawing }),
  (error) => parentPort?.postMessage({ error: error.message }),
);
