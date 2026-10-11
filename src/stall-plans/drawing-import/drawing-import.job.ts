import { PdfReadError, readPageVectors } from '../../venues/floor-plan/cad/pdf-vectors';
import { vectorsToDxf } from './dxf-writer';
import {
  ExtractionError,
  extractStalls,
  stallLayerModes,
  type ExtractionResult,
} from './stall-extraction';

/** One read of a CAD plan PDF: its stalls, or the whole drawing as DXF. */
export interface DrawingJob {
  kind: 'stalls' | 'dxf';
  data: Uint8Array;
  page: number;
}

/** Plain data, so it crosses a worker boundary unchanged. */
export type DrawingOutcome =
  | { ok: true; kind: 'stalls'; result: ExtractionResult }
  | { ok: true; kind: 'dxf'; dxf: string }
  | { ok: false; kind: 'unreadable' | 'unsupported' | 'internal'; message: string };

export async function runDrawingJob(job: DrawingJob): Promise<DrawingOutcome> {
  try {
    if (job.kind === 'stalls') {
      // Only what the extraction uses is kept: a full hall plan then fits a small server.
      const vectors = await readPageVectors(job.data, job.page, { layerMode: stallLayerModes });
      return { ok: true, kind: 'stalls', result: extractStalls(vectors) };
    }
    const vectors = await readPageVectors(job.data, job.page);
    // The stall grid gives the scale; a drawing without one stays in page points.
    let pointsPerMetre: number | null = null;
    try {
      pointsPerMetre = extractStalls(vectors).groups[0]?.pitchX ?? null;
    } catch {
      pointsPerMetre = null;
    }
    return { ok: true, kind: 'dxf', dxf: vectorsToDxf(vectors, pointsPerMetre) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof PdfReadError) return { ok: false, kind: 'unreadable', message };
    if (e instanceof ExtractionError) return { ok: false, kind: 'unsupported', message };
    return { ok: false, kind: 'internal', message };
  }
}
