import { parentPort, workerData } from 'worker_threads';

import { runImport, type PdfImportJob } from './pdf-import.job';

/** Worker-thread entry: runs one import and posts its outcome, so parsing never blocks the API. */
void runImport(workerData as PdfImportJob).then((outcome) => parentPort?.postMessage(outcome));
