import { readPageVectors, type LayerMode, type PageVectors } from './pdf-vectors';
import { globalPitch, fitLattice } from './grid-fit';
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
        ? (layer: string): LayerMode =>
            DECORATIVE.test(layer) ? 'skip' : HATCH.test(layer) ? 'strokes' : 'keep'
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
        Math.hypot(points[0] - points[points.length - 2], points[1] - points[points.length - 1]) <
          0.01;
      if (closed) points.length -= 2;
      polylines.push({ layer: path.layer, color: path.stroke, points, closed });
      if (closed && path.fill) fills.push({ layer: path.layer, color: path.fill, loops: [points] });
    }
  }

  const texts = joinHallTitleFragments(
    vectors.texts
      .filter((t) => t.text.trim())
      .map((t) => ({ layer: '', text: t.text.trim(), x: t.x, y: flipY(t.y), height: t.size })),
  );

  const scale = statedScale(texts.map((t) => t.text));
  const grid = gridScale(vectors);
  return {
    format: 'pdf',
    metresPerUnit: grid ? grid.metresPerUnit : scale ? POINT_METRES * scale : null,
    scaleSource: grid
      ? `Scale taken from the printed grid size and CAD grid layer (${grid.lines} grid lines)`
      : scale
        ? `Plan scale 1:${scale} (from the drawing)`
        : 'The PDF does not state its scale',
    gridCell: grid?.cell,
    polylines,
    texts,
    inserts: [],
    fills,
    hatchStrokes,
    layers: vectors.layers,
    warnings: vectors.pageCount > 1 ? [`Only page ${page} of ${vectors.pageCount} was read.`] : [],
  };
}

/** CAD PDF exports can draw "HALL" and its number as separate, adjacent text runs. */
export function joinHallTitleFragments(texts: CadText[]): CadText[] {
  const used = new Set<CadText>();
  const replacements = new Map<CadText, CadText>();
  for (const title of texts) {
    if (!/^(?:exhibition\s+)?hall\s*[-–#]?\s*$/i.test(title.text) || title.height <= 0) continue;
    const number = texts
      .filter(
        (t) =>
          !used.has(t) &&
          /^\d{1,2}[a-z]?$/i.test(t.text) &&
          t.x > title.x &&
          Math.abs(t.y - title.y) < title.height * 0.2 &&
          Math.abs(t.height - title.height) < title.height * 0.2 &&
          t.x - title.x < title.height * (0.31 * (title.text.length + t.text.length) + 1.5),
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!number) continue;
    used.add(number);
    const left = title.x - 0.31 * title.height * title.text.length;
    const right = number.x + 0.31 * number.height * number.text.length;
    replacements.set(title, {
      ...title,
      text: `${title.text} ${number.text}`,
      x: (left + right) / 2,
    });
  }
  return texts.filter((t) => !used.has(t)).map((t) => replacements.get(t) ?? t);
}

/**
 * The scale of a stall plan from its own 1 m grid, fitted by the stall extractor (the same
 * calibration the PDF stall import uses). Only a tight fit is trusted; null otherwise.
 */
export function gridScale(
  vectors: PageVectors,
): { metresPerUnit: number; lines: number; cell: { width: number; height: number } } | null {
  const note = vectors.texts.map((t) => t.text).find((t) => /grid.*(?:size|spacing|cell)/i.test(t));
  const match = note?.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)\b/i,
  );
  if (!match) return null;
  const units: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048 };
  const width = Number(match[1]) * units[match[2] ?? match[4]],
    height = Number(match[3]) * units[match[4]];
  const lines = vectors.paths
    .filter((p) => /^(?:stall[ _-]*)?grid(?:[ _-]*lines)?$/i.test(p.layer.split(/\$0\$|\|/).pop()!))
    .flatMap((p) =>
      p.segments.map((l) => ({
        a: [l.x1, l.y1] as [number, number],
        b: [l.x2, l.y2] as [number, number],
        color: '#777777',
        width: 1,
        dashed: false,
      })),
    );
  const axisLines = (axis: number) => {
    const family = lines.filter((l) => Math.abs(l.a[axis] - l.b[axis]) < 0.05);
    const length = (l: (typeof lines)[number]) => Math.hypot(l.a[0] - l.b[0], l.a[1] - l.b[1]);
    const longest = Math.max(0, ...family.map(length));
    return family.filter((l) => length(l) >= longest * 0.5).map((l) => l.a[axis]);
  };
  const vertical = axisLines(0),
    horizontal = axisLines(1);
  const guess = globalPitch(vertical, horizontal);
  if (!guess || vertical.length < 10 || horizontal.length < 10) return null;
  // Separate halls and detached foyers can have the same pitch at different origins.
  // Fit lines sharing their span instead of forcing the entire sheet onto one phase.
  const fitAxis = (axis: number, coordinates: number[]) => {
    const spans = new Map<string, number[]>();
    for (const l of lines) {
      if (Math.abs(l.a[axis] - l.b[axis]) >= 0.05) continue;
      const ends = [l.a[1 - axis], l.b[1 - axis]].sort((a, b) => a - b);
      const key = ends.map((v) => Math.round(v / 2)).join(':');
      const values = spans.get(key) ?? [];
      values.push(l.a[axis]);
      spans.set(key, values);
    }
    return [coordinates, ...spans.values()]
      .filter((values) => values.length >= 10)
      .map((values) => fitLattice(values, guess))
      .filter((fit) => fit.used >= 10 && fit.rms / fit.pitch <= 0.03)
      .sort((a, b) => b.used - a.used)[0];
  };
  const x = fitAxis(0, vertical),
    y = fitAxis(1, horizontal);
  if (!x || !y) return null;
  const sx = width / x.pitch,
    sy = height / y.pitch;
  if (!sx || !sy || Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) return null;
  return { metresPerUnit: (sx + sy) / 2, lines: x.used + y.used, cell: { width, height } };
}

/** "SCALE 1:200", "Scale - 1 : 500": the ratio a plotted plan states. */
export function statedScale(texts: string[]): number | null {
  const votes = new Map<number, number>();
  for (const text of texts) {
    const match =
      /\bscale\b\s*[:=-]?\s*1\s*:\s*(\d{2,4})\b/i.exec(text) ??
      /^\s*1\s*:\s*(\d{2,4})\s*$/.exec(text);
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
    if (
      current &&
      Math.abs(current[n - 2] - s.x1) < 0.01 &&
      Math.abs(current[n - 1] - s.y1) < 0.01
    ) {
      current.push(s.x2, s.y2);
    } else {
      if (current) out.push(current);
      current = [s.x1, s.y1, s.x2, s.y2];
    }
  }
  if (current) out.push(current);
  return out;
}
