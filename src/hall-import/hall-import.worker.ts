import { parentPort, workerData } from 'worker_threads';
import { runHallImport, type HallImportJob } from './hall-import.job';

/** Worker-thread entry: analyses one plan and posts its outcome, so parsing never blocks the API. */
void runHallImport(workerData as HallImportJob).then((outcome) => parentPort?.postMessage(outcome));
