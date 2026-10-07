import { parentPort, workerData } from 'node:worker_threads';

import { DrawingAnalysisInput, runDrawingAnalysis } from './drawing-analysis';

/** Worker-thread entry: analyses one plan and posts the outcome, so the API never stalls. */
void runDrawingAnalysis(workerData as DrawingAnalysisInput).then((outcome) =>
  parentPort?.postMessage(outcome),
);
