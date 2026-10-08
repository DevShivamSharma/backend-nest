import { area, bounds, inside, rectangle, transform, union } from './geometry';
import type { SourcePage, Segment } from './source';
import { enhanceWithCad } from './cad-adapter';
import { detectAnnotations } from './annotations';
import type { Grid, MultiPolygon, PlanPage, PlanRegion, Point, TextBox } from './plan.types';

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rotate = (p: Point, a: number): Point => [
  p[0] * Math.cos(a) - p[1] * Math.sin(a),
  p[0] * Math.sin(a) + p[1] * Math.cos(a),
];
function grey(c: string): boolean {
  const rgb = c.match(/[\da-f]{2}/gi)?.map((x) => parseInt(x, 16)) ?? [];
  return rgb.length === 3 && Math.max(...rgb) - Math.min(...rgb) < 35 && Math.max(...rgb) < 235;
}
function median(a: number[]): number {
  const s = [...a].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function pitch(values: number[], min: number): number | null {
  const unique = [...values]
    .sort((a, b) => a - b)
    .filter((x, i, a) => i === 0 || x - a[i - 1] > min);
  const diffs = unique
    .slice(1)
    .map((x, i) => x - unique[i])
    .filter((x) => x > min * 3);
  let best: number[] = [];
  for (const d of diffs) {
    const near = diffs.filter((x) => Math.abs(x - d) < Math.max(min, d * 0.035));
    if (near.length > best.length) best = near;
  }
  return best.length >= 4 ? median(best) : null;
}
export function joinedTexts(texts: TextBox[]): TextBox[] {
  const lines: TextBox[][] = [];
  for (const t of [...texts].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l[0].y - t.y) < Math.min(l[0].height, t.height) * 0.35);
    if (line) line.push(t);
    else lines.push([t]);
  }
  const out: TextBox[] = [];
  for (const l of lines) {
    let prev: TextBox | null = null;
    for (const t of l.sort((a, b) => a.x - b.x)) {
      if (
        prev &&
        Math.min(t.height, prev.height) / Math.max(t.height, prev.height) > 0.75 &&
        t.x - (prev.x + prev.width) <
          Math.max(t.height, prev.height) * (/^=/.test(t.text) ? 8 : 1.4) &&
        t.x >= prev.x
      ) {
        prev.text += ' ' + t.text;
        prev.width = t.x + t.width - prev.x;
      } else {
        prev = { ...t };
        out.push(prev);
      }
    }
  }
  return out;
}
interface GridRegion {
  geometry: MultiPolygon;
  grid: Grid;
  score: number;
}
/** Find repeated orthogonal line families; no venue names, palettes or cell sizes are assumed. */
export function detectGrids(page: SourcePage): GridRegion[] {
  const min =
    Math.max(page.width, page.height) /
    (page.format === 'pdf-scan' || page.format === 'image' ? 4000 : 20000);
  const groups = new Map<string, Segment[]>();
  const candidates = page.lines.some((l) => l.gridCandidate)
    ? page.lines.filter((l) => l.gridCandidate)
    : page.lines;
  for (const l of candidates) {
    if (l.dashed || !grey(l.color) || dist(l.a, l.b) < min * 80) continue;
    const key = l.color + '/' + (Math.round(l.width / (min || 1)) * min).toFixed(3);
    const g = groups.get(key) ?? [];
    g.push(l);
    groups.set(key, g);
  }
  const results: GridRegion[] = [];
  for (const lines of groups.values()) {
    if (lines.length < 16 || lines.length > 20000) continue;
    const angles = new Map<number, number>();
    for (const l of lines) {
      let a = Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]);
      a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      if (a > Math.PI / 4) a -= Math.PI / 2;
      const k = Math.round(((a * 180) / Math.PI) * 2);
      angles.set(k, (angles.get(k) ?? 0) + dist(l.a, l.b));
    }
    const angle = ((([...angles].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0) / 2) * Math.PI) / 180;
    const local = lines.map((l) => ({ ...l, a: rotate(l.a, -angle), b: rotate(l.b, -angle) }));
    const v = local.filter(
      (l) => Math.abs(l.a[0] - l.b[0]) < Math.max(min, dist(l.a, l.b) * 0.008),
    );
    const h = local.filter(
      (l) => Math.abs(l.a[1] - l.b[1]) < Math.max(min, dist(l.a, l.b) * 0.008),
    );
    const px = pitch(
        v.map((l) => (l.a[0] + l.b[0]) / 2),
        min * 2,
      ),
      py = pitch(
        h.map((l) => (l.a[1] + l.b[1]) / 2),
        min * 2,
      );
    if (
      !px ||
      !py ||
      Math.max(px, py) > Math.min(page.width, page.height) / 4 ||
      Math.max(px, py) / Math.min(px, py) > 2
    )
      continue;
    const all = [...v, ...h],
      parent = all.map((_, i) => i),
      root = (i: number): number => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
    const tol = Math.min(px, py) * 0.08;
    // Intersections link a grid, while neighbouring halls with a non-grid foyer stay separate.
    for (let i = 0; i < v.length; i++)
      for (let j = 0; j < h.length; j++) {
        const vl = v[i],
          hl = h[j],
          x = (vl.a[0] + vl.b[0]) / 2,
          y = (hl.a[1] + hl.b[1]) / 2;
        if (
          x >= Math.min(hl.a[0], hl.b[0]) - tol &&
          x <= Math.max(hl.a[0], hl.b[0]) + tol &&
          y >= Math.min(vl.a[1], vl.b[1]) - tol &&
          y <= Math.max(vl.a[1], vl.b[1]) + tol
        )
          parent[root(i)] = root(v.length + j);
      }
    const components = new Map<number, Segment[]>();
    all.forEach((l, i) => {
      const key = root(i),
        g = components.get(key) ?? [];
      g.push(l);
      components.set(key, g);
    });
    for (const group of components.values()) {
      if (group.length < 12) continue;
      const vertical = group
        .filter((l) => Math.abs(l.a[0] - l.b[0]) < tol)
        .sort((a, b) => a.a[0] - b.a[0]);
      const strips: MultiPolygon[] = [];
      for (let i = 0; i < vertical.length; i++)
        for (let j = i + 1; j < vertical.length; j++) {
          const a = vertical[i],
            b = vertical[j],
            dx = b.a[0] - a.a[0];
          if (dx > px * 1.12) break;
          if (dx < px * 0.85) continue;
          const top = Math.max(Math.min(a.a[1], a.b[1]), Math.min(b.a[1], b.b[1])),
            bottom = Math.min(Math.max(a.a[1], a.b[1]), Math.max(b.a[1], b.b[1]));
          if (bottom - top >= py * 2) strips.push(rectangle(a.a[0], top, dx, bottom - top));
        }
      if (!strips.length) continue;
      let geometry: MultiPolygon = [];
      for (let i = 0; i < strips.length; i += 100)
        geometry = union(geometry, ...strips.slice(i, i + 100));
      if (area(geometry) < Math.max(px * py * 12, page.width * page.height * 0.001)) continue;
      const b = bounds(geometry),
        origin = rotate([b.x, b.y], angle);
      geometry = transform(geometry, (p) => rotate(p, angle));
      results.push({
        geometry,
        grid: {
          x: origin[0],
          y: origin[1],
          width: px,
          height: py,
          rotation: (angle * 180) / Math.PI,
        },
        score: group.length,
      });
    }
  }
  // The densest line family wins when a drawing uses major and minor grid lines together.
  const kept: GridRegion[] = [];
  for (const r of results.sort((a, b) => b.score - a.score)) {
    const b = bounds(r.geometry),
      centre: Point = [b.x + b.width / 2, b.y + b.height / 2];
    if (!kept.some((k) => inside(centre, k.geometry))) kept.push(r);
  }
  return kept.sort((a, b) => bounds(a.geometry).x - bounds(b.geometry).x);
}

function boundaryNearLabel(page: SourcePage, t: TextBox): MultiPolygon | null {
  const cx = t.x + t.width / 2,
    cy = t.y + t.height / 2,
    min = Math.max(page.width, page.height) * 0.004;
  const h = page.lines.filter(
    (l) =>
      Math.abs(l.a[1] - l.b[1]) < min * 0.1 &&
      Math.min(l.a[0], l.b[0]) <= cx &&
      Math.max(l.a[0], l.b[0]) >= cx &&
      dist(l.a, l.b) > t.width * 0.5,
  );
  const v = page.lines.filter(
    (l) =>
      Math.abs(l.a[0] - l.b[0]) < min * 0.1 &&
      Math.min(l.a[1], l.b[1]) <= cy &&
      Math.max(l.a[1], l.b[1]) >= cy &&
      dist(l.a, l.b) > t.height * 2,
  );
  const top = Math.max(...h.filter((l) => l.a[1] < cy - min).map((l) => l.a[1])),
    bottom = Math.min(...h.filter((l) => l.a[1] > cy + min).map((l) => l.a[1]));
  const left = Math.max(...v.filter((l) => l.a[0] < cx - min).map((l) => l.a[0])),
    right = Math.min(...v.filter((l) => l.a[0] > cx + min).map((l) => l.a[0]));
  return [left, right, top, bottom].every(Number.isFinite) &&
    right - left > min &&
    bottom - top > min
    ? rectangle(left, top, right - left, bottom - top)
    : null;
}
export function analysePage(source: SourcePage): PlanPage {
  const texts = joinedTexts(source.texts);
  const rawGrids = detectGrids(source);
  const hallLabels = texts.filter(
    (t) =>
      /^(?:exhibition\s+)?halls?\s*[-:]?\s*[\p{L}\d]+(?:\s*(?:gf|ff|ground|first))?$/iu.test(
        t.text,
      ) && !/^(hall\s*(no|layout|area))$/i.test(t.text),
  );
  const uniqueLabels = hallLabels.filter(
    (t) =>
      !hallLabels.some(
        (other) =>
          other !== t &&
          other.text.replace(/[^a-z0-9]/gi, '').toLowerCase() ===
            t.text.replace(/[^a-z0-9]/gi, '').toLowerCase() &&
          other.height > t.height,
      ),
  );
  const foyerLabels = texts.filter((t) =>
    /^(foyer|lobby|circulation)(?:\s*[-:]?\s+[\w-]+|[-:][\w-]+)?$/i.test(t.text),
  );
  const containsLabel = (g: GridRegion, t: TextBox) =>
    inside([t.x + t.width / 2, t.y + t.height / 2], g.geometry);
  const largestGrid = Math.max(0, ...rawGrids.map((g) => area(g.geometry)));
  const zoneGrids = rawGrids.filter(
    (g) =>
      !uniqueLabels.some((t) => containsLabel(g, t)) &&
      foyerLabels.some(
        (t) =>
          containsLabel(g, t) &&
          (/^(foyer|circulation)/i.test(t.text) || area(g.geometry) < largestGrid * 0.25),
      ),
  );
  const hallGrids = rawGrids.filter((g) => !zoneGrids.includes(g));
  const internalLabels = uniqueLabels.filter((t) => hallGrids.some((g) => containsLabel(g, t)));
  const largestTitle = [...uniqueLabels].sort((a, b) => b.height - a.height)[0];
  // Large single-hall titles identify the drawing; small external hall labels often identify
  // directions to adjacent buildings, and must not name a detached foyer grid.
  const prominentTitle =
    largestTitle &&
    /^exhibition\s+halls?/i.test(largestTitle.text) &&
    uniqueLabels.every((t) => t === largestTitle || largestTitle.height >= t.height * 1.4);
  const primaryLabels = internalLabels.length
    ? internalLabels
    : prominentTitle
      ? [largestTitle]
      : uniqueLabels;
  const grids = consolidateRasterGrids(source, hallGrids, primaryLabels, foyerLabels);
  const used = new Set<TextBox>();
  const regions: PlanRegion[] = grids.map((g, i) => {
    const b = bounds(g.geometry);
    const label = primaryLabels
      .filter((t) => !used.has(t))
      .sort((a, z) => {
        const score = (t: TextBox) => {
          const x = t.x + t.width / 2,
            y = t.y + t.height / 2;
          return inside([x, y], g.geometry)
            ? 0
            : Math.hypot(
                Math.max(b.x - x, 0, x - b.x - b.width) * 2,
                Math.max(b.y - y, 0, y - b.y - b.height),
              );
        };
        return score(a) - score(z);
      })[0];
    if (label) used.add(label);
    const name = label?.text.replace(/\s+/g, ' ').trim() ?? `Hall ${i + 1}`;
    const printed = texts.find(
      (t) =>
        t.text.toLowerCase().startsWith(name.toLowerCase() + ' ') &&
        /\d+\.?\d*\s*(?:sq\.?\s*m|m²)/i.test(t.text),
    );
    const value = printed?.text.match(/(?:=|:)\s*([\d,.]+)\s*(?:sq\.?\s*m|m²)/i);
    return {
      id: `p${source.number}-hall-${i + 1}`,
      name,
      role: 'hall',
      geometry: g.geometry,
      hallIds: [],
      confirmed: false,
      grid: g.grid,
      printedArea: value ? Number(value[1].replace(/,/g, '')) : null,
    };
  });
  // Non-grid plans still get editable candidates from labels and enclosing linework.
  if (!regions.length)
    for (const t of hallLabels) {
      const g = boundaryNearLabel(source, t);
      if (g)
        regions.push({
          id: `p${source.number}-hall-${regions.length + 1}`,
          name: t.text,
          role: 'hall',
          geometry: g,
          hallIds: [],
          confirmed: false,
          grid: null,
          printedArea: null,
        });
    }
  for (const t of foyerLabels) {
    const gridZone = zoneGrids.find((g) =>
      inside([t.x + t.width / 2, t.y + t.height / 2], g.geometry),
    );
    const g = gridZone?.geometry ?? boundaryNearLabel(source, t);
    if (!g) continue;
    const b = bounds(g);
    if (b.width * b.height > source.width * source.height * 0.3) continue;
    // A bare lobby caption near curved/open linework is not evidence for an enormous box.
    // Keep uncertain enclosures out of the saved floor until the user traces them.
    if (!gridZone && /^lobby$/i.test(t.text) && Math.max(b.width, b.height) > t.height * 20)
      continue;
    const centre: Point = [t.x + t.width / 2, t.y + t.height / 2];
    const candidateHalls = regions.filter((r) => r.role === 'hall');
    const distance = (r: PlanRegion) => {
      const q = bounds(r.geometry);
      return Math.hypot(
        Math.max(q.x - centre[0], 0, centre[0] - q.x - q.width),
        Math.max(q.y - centre[1], 0, centre[1] - q.y - q.height),
      );
    };
    const labelKey = (name: string) =>
      name
        .replace(
          /^(?:exhibition\s+)?halls?\s*[-:]?\s*|^(?:foyer|lobby|circulation)\s*[-:]?\s*/i,
          '',
        )
        .trim()
        .toLowerCase()
        .replace(/^(\d+)[fg]$/, '$1');
    const matching = candidateHalls.filter((r) => labelKey(r.name) === labelKey(t.text));
    const sorted = [...candidateHalls].sort((a, b) => distance(a) - distance(b));
    const tolerance = Math.max(
      sorted[0]?.grid?.width ?? 0,
      sorted[0]?.grid?.height ?? 0,
      Math.max(source.width, source.height) * 0.002,
    );
    const nearest = matching.length
      ? matching
      : sorted.slice(0, 2).filter((r) => distance(r) <= distance(sorted[0]) + tolerance);
    const printed = texts
      .find(
        (row) =>
          row.text.toLowerCase().startsWith(t.text.toLowerCase() + ' ') &&
          /sq\.?\s*m|m²/i.test(row.text),
      )
      ?.text.match(/(?:=|:)\s*([\d,.]+)/);
    regions.push({
      id: `p${source.number}-zone-${regions.length + 1}`,
      name: t.text,
      role: /circulation/i.test(t.text) ? 'circulation' : 'foyer',
      geometry: g,
      hallIds: nearest.map((r) => r.id),
      confirmed: false,
      grid: gridZone?.grid ?? nearest[0]?.grid ?? null,
      printedArea: printed ? Number(printed[1].replace(/,/g, '')) : null,
    });
  }
  const grid = grids[0]?.grid ?? null;
  const note = texts.find((t) => /grid.*(?:size|spacing|cell).*\d/i.test(t.text));
  const pair = note?.text.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)\b/i,
  );
  let metresPerUnit = source.unitMetres,
    scaleSource = source.unitMetres ? 'DXF drawing units' : 'Scale not established',
    confirmed = !!source.unitMetres;
  if (pair && grid) {
    const units: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048 };
    const sx = (Number(pair[1]) * (units[pair[2] ?? pair[4]] ?? 1)) / grid.width;
    const sy = (Number(pair[3]) * (units[pair[4]] ?? 1)) / grid.height;
    if (Math.abs(sx - sy) / Math.max(sx, sy) <= 0.02) {
      metresPerUnit = (Number(pair[1]) * (units[pair[2] ?? pair[4]] ?? 1)) / grid.width;
      scaleSource = note!.text;
      confirmed = true;
    } else
      source.warnings.push(
        'Detected X/Y grid pitches disagree with the printed grid note. Set scale from a known distance.',
      );
  }
  const legend = texts
    .filter(
      (t) =>
        /passage|no construction|fire curtain|column|electrical panel|stall (partition|fascia)|emergency exit/i.test(
          t.text,
        ) && t.text.length > 12,
    )
    .map((t) => ({ label: t.text, color: null }));
  const objects: PlanPage['objects'] = [];
  // Filled shapes inside the detected halls remain review candidates. Never turn a colour guess into a restriction.
  for (const f of source.fills) {
    if (!f.rings.length || objects.length >= 500) continue;
    const g: MultiPolygon = f.rings.map((r) => [r]);
    const size = area(g),
      b = bounds(g);
    if (
      size <= 0 ||
      !regions.some(
        (r) => r.role === 'hall' && inside([b.x + b.width / 2, b.y + b.height / 2], r.geometry),
      )
    )
      continue;
    const cellArea = (grid?.width ?? 10) * (grid?.height ?? 10);
    if (
      size < cellArea * 0.3 ||
      size > cellArea * 30 ||
      f.color === '#ffffff' ||
      size / (b.width * b.height) < 0.95 ||
      f.rings.some((r) => r.length > 10)
    )
      continue;
    objects.push({
      id: `p${source.number}-object-${objects.length + 1}`,
      kind: 'unknown',
      label: 'Filled source shape',
      geometry: g,
      color: f.color,
      confirmed: false,
      evidence: {
        source: 'geometry',
        detail: 'Meaning has not been established. Confirm a kind or keep it as a marking.',
      },
    });
  }
  const analysed: PlanPage = {
    number: source.number,
    width: source.width,
    height: source.height,
    format: source.format,
    preview: source.preview,
    texts,
    regions,
    objects,
    calibration: { metresPerUnit, source: scaleSource, confirmed },
    grid,
    dimensions: [],
    legend,
    warnings: [
      ...source.warnings,
      'Hall boundaries, shared-area ownership and restrictions need review before saving.',
      ...(primaryLabels.filter((t) => !used.has(t)).length && grids.length
        ? [
            'Additional hall labels need review: ' +
              primaryLabels
                .filter((t) => !used.has(t))
                .map((t) => t.text)
                .join(', ') +
              '. A continuous grid may contain several halls; draw separate boundaries if needed.',
          ]
        : []),
      ...(!grids.length
        ? ['No reliable grid was detected. Draw hall boundaries and calibrate a known distance.']
        : []),
      ...(foyerLabels.length > regions.filter((r) => r.role === 'foyer').length
        ? [
            'Some foyer labels could not be enclosed automatically. Add their boundaries in the review.',
          ]
        : []),
    ],
  };
  const enhanced = enhanceWithCad(analysed, source.cad);
  enhanced.annotations = detectAnnotations(enhanced);
  return enhanced;
}

/** Raster strokes break at coloured partitions. Label-aligned fragments describe
 * one proposed hall, not dozens of separate halls. Envelopes still need review. */
function consolidateRasterGrids(
  source: SourcePage,
  grids: GridRegion[],
  labels: TextBox[],
  zoneLabels: TextBox[],
): GridRegion[] {
  if (
    !['image', 'pdf-scan'].includes(source.format) ||
    labels.length < 1 ||
    grids.length < labels.length * 2
  )
    return grids;
  const centres = labels.map((t) => [t.x + t.width / 2, t.y + t.height / 2] as Point);
  const range = (axis: number) =>
    Math.max(...centres.map((p) => p[axis])) - Math.min(...centres.map((p) => p[axis]));
  const axis = range(0) >= range(1) ? 0 : 1;
  // Only merge along a clear row/column of names. General layouts stay editable candidates.
  if (labels.length > 1 && range(1 - axis) > Math.max(range(axis) * 0.15, 30)) return grids;
  const hallGrids = grids.filter(
    (g) => !zoneLabels.some((t) => inside([t.x + t.width / 2, t.y + t.height / 2], g.geometry)),
  );
  const groups = labels.map(() => [] as GridRegion[]);
  for (const g of hallGrids) {
    const b = bounds(g.geometry),
      p = [b.x + b.width / 2, b.y + b.height / 2];
    let owner = 0;
    for (let i = 1; i < centres.length; i++)
      if (Math.abs(p[axis] - centres[i][axis]) < Math.abs(p[axis] - centres[owner][axis]))
        owner = i;
    groups[owner].push(g);
  }
  source.warnings.push(
    'Raster grid fragments were grouped by hall labels. These hall envelopes are proposals; check all perimeter cells and foyer boundaries before saving.',
  );
  return groups
    .filter((g) => g.length)
    .map((group) => {
      const b = bounds(union(...group.map((g) => g.geometry))),
        base = group.reduce((a, b) => (a.score > b.score ? a : b));
      return {
        ...base,
        geometry: rectangle(b.x, b.y, b.width, b.height),
        score: group.reduce((s, g) => s + g.score, 0),
      };
    })
    .sort((a, b) => bounds(a.geometry).x - bounds(b.geometry).x);
}
