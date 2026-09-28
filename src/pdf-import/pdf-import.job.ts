import { PdfReadError, readPageVectors } from './pdf-vectors';
import {
  ExtractionError,
  extractStalls,
  stallLayerModes,
  type ExtractionResult,
} from './stall-extraction';

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
    // Only what the extraction uses is kept: a full hall plan then fits a small server.
    const vectors = await readPageVectors(job.data, job.page, { layerMode: stallLayerModes });
    return { ok: true, result: extractStalls(vectors) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof PdfReadError) return { ok: false, kind: 'unreadable', message };
    if (e instanceof ExtractionError) return { ok: false, kind: 'unsupported', message };
    return { ok: false, kind: 'internal', message };
  }
}
