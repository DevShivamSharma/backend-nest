import { parentPort, workerData } from 'worker_threads';

import { runDrawingJob, type DrawingJob } from './drawing-import.job';

/** Worker-thread entry: runs one read and posts its outcome, so parsing never blocks the API. */
void runDrawingJob(workerData as DrawingJob).then((outcome) => parentPort?.postMessage(outcome));
