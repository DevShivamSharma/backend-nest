import { PdfReadError, readPageVectors, type PageVectors } from '../cad/pdf-vectors';
import { dxfToVectors, isAsciiDxf } from './dxf-reader';
import { vectorsToDxf } from './dxf-writer';
import { forHall, type HallStalls, WrongPlanError } from './hall-match';
import { type OverlayImage, renderOverlay } from './overlay-image';
import { ExtractionError, extractStalls, type ExtractionResult } from './stall-extraction';

/** One read of a CAD plan (PDF or DXF): its stalls, or the whole drawing as DXF. */
export interface DrawingJob {
  kind: 'stalls' | 'dxf';
  data: Uint8Array;
  page: number;
  /** For `stalls`: the hall the plan is for. Its stalls are picked out, and the drawing is pictured for a second look. */
  hall?: { name: string; code: string | null };
}

/** Plain data, so it crosses a worker boundary unchanged. */
export type DrawingOutcome =
  | {
      ok: true;
      kind: 'stalls';
      result: ExtractionResult;
      /** With `hall` given: this hall's stalls, and the picture of them over the drawing. */
      hallStalls?: HallStalls;
      overlay?: OverlayImage | null;
    }
  | { ok: true; kind: 'dxf'; dxf: string }
  | { ok: false; kind: 'unreadable' | 'unsupported' | 'internal'; message: string };

/**
 * A plan PDF is converted to DXF first, and the stalls are read from that DXF: one drawing
 * model for both formats, and the converted drawing is what the planner can also download. A DXF
 * upload is read as it is. Stall lines are in the drawing's units; page points for a PDF.
 */
export async function runDrawingJob(job: DrawingJob): Promise<DrawingOutcome> {
  try {
    const dxfText = await toDxf(job.data, job.page);
    if (job.kind === 'stalls') {
      const vectors = dxfToVectors(dxfText.pointsDxf);
      const result = extractStalls(vectors);
      if (!job.hall) return { ok: true, kind: 'stalls', result };
      const hallStalls = forHall(result, job.hall.name, job.hall.code);
      return {
        ok: true,
        kind: 'stalls',
        result,
        hallStalls,
        overlay: renderOverlay(vectors, hallStalls.stalls, hallStalls.unresolved),
      };
    }
    return { ok: true, kind: 'dxf', dxf: dxfText.metresDxf };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof PdfReadError) return { ok: false, kind: 'unreadable', message };
    if (e instanceof WrongPlanError) return { ok: false, kind: 'unsupported', message };
    if (e instanceof ExtractionError) return { ok: false, kind: 'unsupported', message };
    return { ok: false, kind: 'internal', message };
  }
}

/** The drawing as DXF text twice: in page points (what the extraction reads) and in metres. */
async function toDxf(
  data: Uint8Array,
  page: number,
): Promise<{ pointsDxf: string; metresDxf: string }> {
  if (isAsciiDxf(data)) {
    const text = Buffer.from(data).toString('utf8');
    return { pointsDxf: text, metresDxf: text };
  }
  const vectors = await readPageVectors(data, page);
  return {
    pointsDxf: vectorsToDxf(vectors, null),
    metresDxf: vectorsToDxf(vectors, pitchOf(vectors)),
  };
}

/** The stall grid gives the scale; a drawing without one stays in page points. */
function pitchOf(vectors: PageVectors): number | null {
  try {
    return extractStalls(vectors).groups[0]?.pitchX ?? null;
  } catch {
    return null;
  }
}
