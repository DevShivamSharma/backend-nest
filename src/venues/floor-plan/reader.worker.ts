import { parentPort, workerData } from 'node:worker_threads';
import { readSource, SourcePage } from './source';
import { analysePage } from './analyse';
import type { PlanPage } from './plan.types';
const analysed: PlanPage[] = [];
function analyse(source: SourcePage): PlanPage {
  try {
    return analysePage(source);
  } catch (error) {
    return analysePage({
      ...source,
      lines: [],
      fills: [],
      warnings: [
        ...source.warnings,
        `Automatic boundary detection failed: ${error instanceof Error ? error.message : 'unknown error'}. Trace the hall on the original image.`,
      ],
    });
  }
}
void readSource(new Uint8Array(workerData.data), workerData.fileName, (source) => {
  const page = analyse(source);
  const index = analysed.findIndex((previous) => previous.number === page.number);
  if (index < 0) analysed.push(page);
  else analysed[index] = page;
  parentPort!.postMessage({ page });
})
  .then((pages) =>
    parentPort!.postMessage({ pages: analysed.length ? analysed : pages.map(analyse) }),
  )
  .catch((error) =>
    parentPort!.postMessage({
      pages: analysed,
      error: error instanceof Error ? error.message : 'Could not read this file.',
    }),
  );
