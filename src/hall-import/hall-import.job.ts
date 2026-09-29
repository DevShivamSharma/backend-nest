import { PdfReadError } from '../pdf-import/pdf-vectors';
import type { CadDrawing } from './cad-drawing';
import { DxfReadError, readDxf } from './dxf-reader';
import { analyseDrawing, type HallImportResult } from './hall-analysis';
import { readPdfDrawing } from './pdf-drawing';

export type HallPlanFormat = 'dxf' | 'pdf';

export interface HallImportJob {
  data: Uint8Array;
  format: HallPlanFormat;
  fileName: string;
}

/** Plain data, so it crosses a worker boundary unchanged. */
export type HallImportOutcome =
  | { ok: true; result: HallImportResult }
  | { ok: false; kind: 'unreadable' | 'internal'; message: string };

export async function runHallImport(job: HallImportJob): Promise<HallImportOutcome> {
  try {
    const drawing: CadDrawing =
      job.format === 'dxf' ? readDxf(job.data) : await readPdfDrawing(job.data, 1);
    if (!drawing.polylines.length && !drawing.texts.length) {
      return {
        ok: false,
        kind: 'unreadable',
        message:
          job.format === 'pdf'
            ? 'No drawing was found in the PDF: it looks like a scan. Upload it as an image (PNG or JPG) to trace the hall, or use a PDF exported from CAD.'
            : 'The DXF has no drawing in model space.',
      };
    }
    return { ok: true, result: analyseDrawing(drawing, job.fileName) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof DxfReadError || e instanceof PdfReadError) {
      return { ok: false, kind: 'unreadable', message };
    }
    return { ok: false, kind: 'internal', message };
  }
}
