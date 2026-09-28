import { PdfReadError, readPageVectors } from './pdf-vectors';
import { ExtractionError, extractStalls, type ExtractionResult } from './stall-extraction';

export interface PdfImportJob {
  data: Uint8Array;
  page: number;
}

/** Plain data, so it crosses a worker boundary unchanged. */
export type PdfImportOutcome =
  | { ok: true; result: ExtractionResult }
  | { ok: false; kind: 'unreadable' | 'unsupported' | 'internal'; message: string };

export async function runImport(job: PdfImportJob): Promise<PdfImportOutcome> {
  try {
    const vectors = await readPageVectors(job.data, job.page);
    return { ok: true, result: extractStalls(vectors) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof PdfReadError) return { ok: false, kind: 'unreadable', message };
    if (e instanceof ExtractionError) return { ok: false, kind: 'unsupported', message };
    return { ok: false, kind: 'internal', message };
  }
}
