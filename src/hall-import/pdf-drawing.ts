import { readPageVectors, type LayerMode, type PageVectors } from '../pdf-import/pdf-vectors';
import { extractStalls } from '../pdf-import/stall-extraction';
import type { CadDrawing, CadFill, CadPolyline, CadText } from './cad-drawing';

/** One PDF point in metres on paper. */
const POINT_METRES = 0.0254 / 72;

/** Layers that never carry the hall outline, symbols, zones or labels: dropped to save memory. */
const DECORATIVE = /patt|tree|plant|landscape|furn|lite|light|elev-|glaz|jali|ac pipe|pipe/i;
/**
 * Hatch layers: coloured areas (passages, no-construction bands, toilet blocks) drawn as dense
 * parallel strokes. Kept only as flat segments per colour, which is all the legend-colour zone
 * detection needs and a fraction of the memory of full paths.
 */
const HATCH = /hatch/i;

/**
 * Reads page `page` of a vector PDF plan into the common drawing model.
 *
 * Page coordinates (points, y down) are flipped to y up so DXF and PDF share one orientation.
 * A PDF has no units: when the plan states its scale ("SCALE 1:200") the paper size is assumed
 * to be the plotted size; otherwise `metresPerUnit` is null and the review step asks for a real
 * dimension.
 */
export async function readPdfDrawing(data: Uint8Array, page = 1): Promise<CadDrawing> {
  const vectors = await readPageVectors(data, page, {
    layerMode: (layers) =>
      layers.length
        ? (layer: string): LayerMode => (DECORATIVE.test(layer) ? 'skip' : HATCH.test(layer) ? 'strokes' : 'keep')
        : null,
  });
  const flipY = (y: number) => vectors.height - y;

  const polylines: CadPolyline[] = [];
  const fills: CadFill[] = [];
  // Hatch arrives as flat segments per colour (`strokes` mode); flip it like everything else.
  const hatchStrokes: Record<string, number[]> = vectors.strokes ?? {};
  for (const segs of Object.values(hatchStrokes)) {
    for (let i = 1; i < segs.length; i += 2) segs[i] = flipY(segs[i]);
  }
  for (const path of vectors.paths) {
    for (const chain of chains(path.segments)) {
      const points: number[] = [];
      for (let i = 0; i < chain.length; i += 2) points.push(chain[i], flipY(chain[i + 1]));
      const closed =
        points.length >= 6 &&
        Math.hypot(points[0] - points[points.length - 2], points[1] - points[points.length - 1]) < 0.01;
      if (closed) points.length -= 2;
      polylines.push({ layer: path.layer, color: path.stroke, points, closed });
      if (closed && path.fill) fills.push({ layer: path.layer, color: path.fill, loops: [points] });
    }
  }

  const texts: CadText[] = vectors.texts
    .filter((t) => t.text.trim())
    .map((t) => ({ layer: '', text: t.text.trim(), x: t.x, y: flipY(t.y), height: t.size }));

  const scale = statedScale(texts.map((t) => t.text));
  const grid = scale ? null : gridScale(vectors);
  return {
    format: 'pdf',
    metresPerUnit: scale ? POINT_METRES * scale : grid ? grid.metresPerUnit : null,
    scaleSource: scale
      ? `Plan scale 1:${scale} (from the drawing)`
      : grid
        ? `Scale taken from the plan's 1 m grid (${grid.lines} grid lines)`
        : 'The PDF does not state its scale',
    polylines,
    texts,
    inserts: [],
    fills,
    hatchStrokes,
    layers: vectors.layers,
    warnings: vectors.pageCount > 1 ? [`Only page ${page} of ${vectors.pageCount} was read.`] : [],
  };
}

/**
 * The scale of a stall plan from its own 1 m grid, fitted by the stall extractor (the same
 * calibration the PDF stall import uses). Only a tight fit is trusted; null otherwise.
 */
function gridScale(vectors: PageVectors): { metresPerUnit: number; lines: number } | null {
  try {
    const groups = extractStalls(vectors).groups.filter(
      (g) => g.gridLines >= 10 && g.rms < 0.15 && Math.abs(g.pitchX - g.pitchY) <= 0.02 * g.pitchX,
    );
    if (!groups.length) return null;
    const best = groups.sort((a, b) => b.gridLines - a.gridLines)[0];
    return { metresPerUnit: 2 / (best.pitchX + best.pitchY), lines: best.gridLines };
  } catch {
    return null; // no stall grid on this plan
  }
}

/** "SCALE 1:200", "Scale - 1 : 500": the ratio a plotted plan states. */
export function statedScale(texts: string[]): number | null {
  const votes = new Map<number, number>();
  for (const text of texts) {
    const match = /\bscale\b\s*[:=-]?\s*1\s*:\s*(\d{2,4})\b/i.exec(text) ?? /^\s*1\s*:\s*(\d{2,4})\s*$/.exec(text);
    if (!match) continue;
    const n = Number(match[1]);
    if (n >= 20 && n <= 5000) votes.set(n, (votes.get(n) ?? 0) + (/scale/i.test(text) ? 3 : 1));
  }
  let best: number | null = null;
  let most = 0;
  for (const [n, count] of votes) if (count > most) [best, most] = [n, count];
  return best;
}

/** Joins a path's segments into runs of connected points (flat x, y). */
function chains(segments: Array<{ x1: number; y1: number; x2: number; y2: number }>): number[][] {
  const out: number[][] = [];
  let current: number[] | null = null;
  for (const s of segments) {
    const n = current?.length ?? 0;
    if (current && Math.abs(current[n - 2] - s.x1) < 0.01 && Math.abs(current[n - 1] - s.y1) < 0.01) {
      current.push(s.x2, s.y2);
    } else {
      if (current) out.push(current);
      current = [s.x1, s.y1, s.x2, s.y2];
    }
  }
  if (current) out.push(current);
  return out;
}
