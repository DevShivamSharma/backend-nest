import type { Point } from '../layouts/placement/placement-rules';
import { normalizeFootprint, polygonArea } from '../layouts/placement/stall-footprint';
import type { PageVectors, VectorPath, VectorSegment } from './pdf-vectors';

/**
 * Stall extraction from a CAD-exported hall plan (vector PDF).
 *
 * Deterministic, no AI: stall outlines are the closed faces formed by the plan's stall lines —
 * red partitions (closed edges) and fascia lines (open, customer-facing edges) — read by layer.
 * Grid lines, dimension lines, arrows, hatches and annotations are never outlines: they only
 * calibrate (the 1 m grid) or describe (labels). Nothing is invented: a value the drawing does
 * not support is reported as an issue for review, never filled in.
 *
 * Coordinates: input in displayed page points (x right, y down); output per hall group in
 * metres (x right, z down) from that group's own grid origin. Halls 8, 9, 10 and 11 of the
 * IITF 2026 plan each sit on their own offset grid, so every group is calibrated separately.
 */

export type LayerRole = 'closed' | 'open' | 'grid' | 'premium' | 'marquee' | 'kiosk' | 'ignore';

/** Layer-name patterns per role (AutoCAD layer names as exported). Checked in this order. */
export const DEFAULT_LAYER_ROLES: Array<[LayerRole, RegExp]> = [
  ['closed', /^parti(tion|tions|on)?$/i],
  ['open', /^(facia|fascia|facade)$/i],
  ['grid', /^grid$/i],
  ['premium', /premium/i],
  ['marquee', /marque/i],
  ['kiosk', /kiosk/i],
];

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ExtractionIssue {
  code:
    | 'AREA_MISMATCH'
    | 'DIMENSION_MISMATCH'
    | 'MULTIPLE_LABELS'
    | 'NO_LABEL'
    | 'NO_BLOCK'
    | 'DUPLICATE_NAME'
    | 'NO_OPEN_EDGE'
    | 'OFF_GRID'
    | 'HOLE'
    | 'DIAGONAL_EDGE'
    | 'DEFAULT_AREA'
    | 'KIOSK';
  severity: IssueSeverity;
  message: string;
}

export interface ExtractedStall {
  /** Stable key within one extraction. */
  key: string;
  /** Hall group (block-id prefix: "11", "10", "9", "8"), or "?" when none could be found. */
  group: string;
  blockId: string | null;
  letter: string | null;
  /** Suggested stall name: "<block> <letter>", or a key when unlabelled. */
  name: string;
  /** Outline in the group's metres (x right, z down), clockwise, collinear points removed. */
  outline: Point[];
  /** Edges (outline[i] -> outline[i + 1]) drawn as fascia: the open, customer-facing sides. */
  openEdges: number[];
  area: number;
  shape: 'rectangle' | 'L-shape' | 'polygon';
  category: 'standard' | 'premium' | 'marquee' | 'start-up';
  /** What the drawing says inside the stall. */
  labels: { area: number | null; dims: { a: number; b: number } | null; texts: string[] };
  confidence: 'high' | 'medium' | 'low';
  issues: ExtractionIssue[];
  /** Suggested default for the review: false for items that need a decision first. */
  include: boolean;
  /** Outline in page points too, for drawing it over the PDF. */
  outlinePt: Point[];
}

export interface ExcludedRegion {
  reason: string;
  outlinePt: Point[];
  texts: string[];
}

export interface GroupCalibration {
  group: string;
  /** Points per metre along x / y, fitted to this group's own grid lines. */
  pitchX: number;
  pitchY: number;
  /** Page point of the group's grid origin (a grid intersection). */
  originX: number;
  originY: number;
  /** Fit residual in metres (RMS over the grid lines used). */
  rms: number;
  gridLines: number;
  /** Cross-check: explicit "W x L" labels measured on the drawing, max error in metres. */
  dimensionChecks: number;
  dimensionMaxError: number | null;
  /** Whether stall corners fall on half metres (the hall snap step must then allow 0.5 m). */
  usesHalfMetres: boolean;
}

/** A stall label the drawing has, but no closed stall outline around it. */
export interface UnresolvedLabel {
  texts: string[];
  /** Page point of the label. */
  x: number;
  y: number;
  reason: string;
}

export interface ExtractionResult {
  page: { width: number; height: number; rotation: number };
  layers: Array<{ name: string; role: LayerRole; paths: number }>;
  /** false: no stall layers were found and line colours were used instead (less reliable). */
  usedLayers: boolean;
  groups: GroupCalibration[];
  stalls: ExtractedStall[];
  excluded: ExcludedRegion[];
  /** Stall labels with no closed outline: a line is missing in the drawing. Never guessed. */
  unresolved: UnresolvedLabel[];
  issues: string[];
}

export class ExtractionError extends Error {}

const LETTER = /^[A-Z]\d?$/;
const BLOCK = /^(\d{1,2})-(\d{1,2})$/;
const AREA = /^=?\s*(\d+(?:\.\d+)?)\s*(?:m²|m2|sqm|sq\.?\s*m)$/i;
const DIMS = /(\d+(?:\.\d+)?)\s*m?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*m\b/i;
const STARTUP = /start[\s-]?up/i;

export function extractStalls(page: PageVectors): ExtractionResult {
  const issues: string[] = [];

  // --- 1. roles ---------------------------------------------------------------------------------
  const roleOf = (layer: string): LayerRole => {
    for (const [role, re] of DEFAULT_LAYER_ROLES) if (re.test(layer)) return role;
    return 'ignore';
  };
  const layerCount = new Map<string, number>();
  for (const p of page.paths) layerCount.set(p.layer, (layerCount.get(p.layer) ?? 0) + 1);
  const layers = [...layerCount.entries()]
    .map(([name, paths]) => ({ name, role: roleOf(name), paths }))
    .sort((a, b) => b.paths - a.paths);

  let usedLayers = page.paths.some((p) => roleOf(p.layer) === 'closed' && p.stroke);
  const role = (p: VectorPath): LayerRole => {
    if (usedLayers) return roleOf(p.layer);
    // No stall layers: fall back to the usual CAD colours. Everything found this way is at best
    // medium confidence.
    if (!p.stroke) return 'ignore';
    if (p.stroke === '#ff0000' && p.width >= 1.1) return 'closed';
    if (p.stroke === '#ff00ff' && p.width >= 0.8) return 'open';
    if (/^#(a|b|c)[0-9a-f]\1?/.test(p.stroke) && p.width <= 0.7) return 'grid';
    return 'ignore';
  };
  if (!usedLayers) {
    issues.push('The PDF has no stall layers (PARTITION / FACIA); stall lines were found by colour instead. Review everything.');
  }

  const edgeSegs: Array<VectorSegment & { open: boolean }> = [];
  const gridSegs: VectorSegment[] = [];
  const hatch: Array<{ x: number; y: number; kind: 'premium' | 'marquee' }> = [];
  const kiosks: VectorSegment[] = [];
  for (const p of page.paths) {
    const r = role(p);
    if ((r === 'closed' || r === 'open') && p.stroke && p.width > 0.3) {
      for (const s of p.segments) edgeSegs.push({ ...s, open: r === 'open' });
    } else if (r === 'grid' && p.stroke) {
      gridSegs.push(...p.segments);
    } else if (r === 'premium' || r === 'marquee') {
      for (const s of p.segments) hatch.push({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, kind: r });
    } else if (r === 'kiosk') {
      kiosks.push(...p.segments);
    }
  }
  if (!usedLayers && !edgeSegs.length) {
    throw new ExtractionError('No stall lines found: the PDF has neither stall layers nor red/magenta stall lines.');
  }

  // --- 2. global scale from the grid ----------------------------------------------------------------
  const gridV = gridSegs.filter((s) => Math.abs(s.x1 - s.x2) < 0.05).map((s) => (s.x1 + s.x2) / 2);
  const gridH = gridSegs.filter((s) => Math.abs(s.y1 - s.y2) < 0.05).map((s) => (s.y1 + s.y2) / 2);
  const pitch = globalPitch([...gridV], [...gridH]);
  if (!pitch) {
    throw new ExtractionError('No 1 m grid could be measured on the drawing, so its scale is unknown.');
  }

  // --- 3. stall lines: axis-aligned, dashes merged, gaps closed ---------------------------------
  const tol = 0.12 * pitch;
  const diag: VectorSegment[] = [];
  const H: Array<{ c: number; lo: number; hi: number; open: boolean }> = [];
  const V: Array<{ c: number; lo: number; hi: number; open: boolean }> = [];
  for (const s of edgeSegs) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.02 * pitch) continue;
    if (Math.abs(dy) <= 0.02 * len) H.push({ c: (s.y1 + s.y2) / 2, lo: Math.min(s.x1, s.x2), hi: Math.max(s.x1, s.x2), open: s.open });
    else if (Math.abs(dx) <= 0.02 * len) V.push({ c: (s.x1 + s.x2) / 2, lo: Math.min(s.y1, s.y2), hi: Math.max(s.y1, s.y2), open: s.open });
    else diag.push(s);
  }
  const hLines = mergeLines(H, tol, 0.9 * pitch);
  const vLines = mergeLines(V, tol, 0.9 * pitch);
  extendToMeet(hLines, vLines, 0.6 * pitch, tol);
  extendToMeet(vLines, hLines, 0.6 * pitch, tol);

  // --- 4. faces: coordinate-compressed cells, flood fill, trace ---------------------------------
  const faces = traceFaces(hLines, vLines, tol);

  // --- 5. texts -------------------------------------------------------------------------------------
  const texts = page.texts.map((t) => ({ ...t, text: t.text.replace(/\s+/g, ' ').trim() }));

  // --- 6. per face: labels, roles, grid support ---------------------------------------------------
  interface Face {
    pt: Point[];
    holes: number;
    texts: string[];
    letters: string[];
    areaLabels: number[];
    dims: { a: number; b: number }[];
    startup: boolean;
    open: boolean[];
    onGrid: boolean;
    diagonal: boolean;
    hatch: { premium: number; marquee: number };
    kiosk: boolean;
    block: string | null;
    blockInferred: boolean;
  }
  const faceList: Face[] = [];
  for (const f of faces) {
    const inside = texts.filter((t) => pointInPolygon({ x: t.x, z: t.y }, f.outer));
    const letters = inside.map((t) => t.text).filter((t) => LETTER.test(t));
    const areaLabels = inside.map((t) => AREA.exec(t.text)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    const dims = inside
      .map((t) => DIMS.exec(t.text))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ a: Number(m[1]), b: Number(m[2]) }));
    const bb = bounds(f.outer);
    const crossesV = gridSegs.some((s) => Math.abs(s.x1 - s.x2) < 0.05 && s.x1 > bb.minX + tol && s.x1 < bb.maxX - tol && Math.min(s.y1, s.y2) < bb.maxY && Math.max(s.y1, s.y2) > bb.minY);
    const crossesH = gridSegs.some((s) => Math.abs(s.y1 - s.y2) < 0.05 && s.y1 > bb.minY + tol && s.y1 < bb.maxY - tol && Math.min(s.x1, s.x2) < bb.maxX && Math.max(s.x1, s.x2) > bb.minX);
    const small = bb.maxX - bb.minX < 1.5 * pitch || bb.maxY - bb.minY < 1.5 * pitch;
    const count = { premium: 0, marquee: 0 };
    for (const h of hatch) {
      if (h.x < bb.minX || h.x > bb.maxX || h.y < bb.minY || h.y > bb.maxY) continue;
      if (pointInPolygon({ x: h.x, z: h.y }, f.outer)) count[h.kind]++;
    }
    faceList.push({
      pt: f.outer,
      holes: f.holes,
      texts: inside.map((t) => t.text),
      letters,
      areaLabels,
      dims,
      startup: inside.some((t) => STARTUP.test(t.text)),
      open: f.outer.map((a, i) => edgeOpenness(a, f.outer[(i + 1) % f.outer.length], hLines, vLines, tol) > 0.5),
      onGrid: (crossesV && crossesH) || (small && (crossesV || crossesH)),
      diagonal: diag.some((d) => pointInPolygon({ x: (d.x1 + d.x2) / 2, z: (d.y1 + d.y2) / 2 }, f.outer)),
      hatch: count,
      kiosk: kiosks.some((k) => pointInPolygon({ x: (k.x1 + k.x2) / 2, z: (k.y1 + k.y2) / 2 }, f.outer)),
      block: null,
      blockInferred: false,
    });
  }

  const excluded: ExcludedRegion[] = [];
  const onGrid = faceList.filter((f) => {
    if (f.onGrid) return true;
    excluded.push({ reason: 'Not on the hall grid (a detail or legend drawing): not imported.', outlinePt: f.pt, texts: f.texts });
    return false;
  });

  // --- 7. blocks: adjacent faces; block ids placed next to them ------------------------------------
  const adjacency = onGrid.map(() => [] as number[]);
  for (let i = 0; i < onGrid.length; i++) {
    for (let j = i + 1; j < onGrid.length; j++) {
      // Touching, or facing each other across a gap too narrow for an aisle (< 1.5 m): a stall
      // lost to an unclosed outline must not split its block in two.
      if (shareEdge(onGrid[i].pt, onGrid[j].pt, tol, 0.5 * pitch) || nearlyTouch(onGrid[i].pt, onGrid[j].pt, 1.5 * pitch, 0.5 * pitch)) {
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }
  const component = onGrid.map(() => -1);
  let components = 0;
  for (let i = 0; i < onGrid.length; i++) {
    if (component[i] >= 0) continue;
    const stack = [i];
    component[i] = components;
    while (stack.length) {
      const k = stack.pop()!;
      for (const n of adjacency[k]) if (component[n] < 0) { component[n] = components; stack.push(n); }
    }
    components++;
  }
  // Distance from a point to a group of stalls: to its nearest stall, never to the group's
  // bounding box (an L-shaped row along two walls would swallow every label inside its box).
  const faceBounds = onGrid.map((f) => bounds(f.pt));
  const compFaces: number[][] = Array.from({ length: components }, () => []);
  component.forEach((c, i) => compFaces[c].push(i));
  const compBounds = compFaces.map((ids) => ids.map((i) => faceBounds[i]));
  // Block numbers are printed just outside their block. Each label belongs to the nearest group
  // of touching stalls; within a group several blocks can touch (a row along a wall), so each
  // stall then takes the nearest of that group's labels.
  const compLabels: Array<typeof texts> = Array.from({ length: components }, () => []);
  for (const label of texts.filter((t) => BLOCK.test(t.text))) {
    let best = -1;
    let bestD = 3 * pitch;
    compBounds.forEach((list, c) => {
      const d = Math.min(...list.map((b) => rectDistance({ x: label.x, z: label.y }, b)));
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best >= 0) compLabels[best].push(label);
  }
  // A group with no label of its own (e.g. its labelled stall is the one left unclosed in the
  // drawing) may take a block number no other group claimed, if one is printed within 8 m.
  // Flagged as inferred for review.
  const claimed = new Set(compLabels.flat());
  const unclaimed = texts.filter((t) => BLOCK.test(t.text) && !claimed.has(t));
  const inferred = new Set<number>();
  compLabels.forEach((labels, c) => {
    if (labels.length) return;
    let best: (typeof texts)[number] | null = null;
    let bestD = 8 * pitch;
    for (const label of unclaimed) {
      const d = Math.min(...compBounds[c].map((b) => rectDistance({ x: label.x, z: label.y }, b)));
      if (d < bestD) { bestD = d; best = label; }
    }
    if (best) { labels.push(best); inferred.add(c); }
  });
  onGrid.forEach((f, i) => {
    f.blockInferred = inferred.has(component[i]);
    const labels = compLabels[component[i]];
    if (!labels.length) return;
    const b = bounds(f.pt);
    f.block = labels.reduce((best, l) => (rectDistance({ x: l.x, z: l.y }, b) < rectDistance({ x: best.x, z: best.y }, b) ? l : best)).text;
  });

  // --- 8. groups and per-group calibration ------------------------------------------------------------
  const groupOf = (f: Face): string => {
    const m = f.block ? BLOCK.exec(f.block) : null;
    return m ? String(Number(m[1])) : '?';
  };
  // Unblocked faces join the nearest blocked face's group.
  const grouped = onGrid.map((f) => ({ f, g: groupOf(f) }));
  for (const item of grouped.filter((x) => x.g === '?')) {
    const c = centroidOf(item.f.pt);
    let best: { g: string; d: number } = { g: '?', d: 25 * pitch };
    for (const other of grouped) {
      if (other.g === '?') continue;
      const d = rectDistance(c, bounds(other.f.pt));
      if (d < best.d) best = { g: other.g, d };
    }
    item.g = best.g;
  }

  const groups: GroupCalibration[] = [];
  const stalls: ExtractedStall[] = [];
  const groupIds = [...new Set(grouped.map((x) => x.g))].sort((a, b) => (a === '?' ? 1 : b === '?' ? -1 : Number(b) - Number(a)));
  for (const g of groupIds) {
    const members = grouped.filter((x) => x.g === g).map((x) => x.f);
    const bb = bounds(members.flatMap((f) => f.pt));
    const margin = 1 * pitch;
    const nearV = gridSegs.filter((s) => Math.abs(s.x1 - s.x2) < 0.05 && s.x1 > bb.minX - margin && s.x1 < bb.maxX + margin && Math.max(s.y1, s.y2) > bb.minY && Math.min(s.y1, s.y2) < bb.maxY).map((s) => s.x1);
    const nearH = gridSegs.filter((s) => Math.abs(s.y1 - s.y2) < 0.05 && s.y1 > bb.minY - margin && s.y1 < bb.maxY + margin && Math.max(s.x1, s.x2) > bb.minX && Math.min(s.x1, s.x2) < bb.maxX).map((s) => s.y1);
    // One plot, one scale: the metre is the page's grid pitch; each hall only has its own
    // grid ORIGIN (Halls 8, 9, 10 and 11 are each drawn on their own offset grid).
    const fx = fitOrigin(nearV, pitch);
    const fy = fitOrigin(nearH, pitch);
    const cal: GroupCalibration = {
      group: g,
      pitchX: fx.pitch,
      pitchY: fy.pitch,
      originX: fx.origin,
      originY: fy.origin,
      rms: Math.max(fx.rms / fx.pitch, fy.rms / fy.pitch),
      gridLines: fx.used + fy.used,
      dimensionChecks: 0,
      dimensionMaxError: null,
      usesHalfMetres: false,
    };
    const toM = (p: Point): Point => ({ x: (p.x - cal.originX) / cal.pitchX, z: (p.z - cal.originY) / cal.pitchY });

    for (const f of members) {
      const stallIssues: ExtractionIssue[] = [];
      let offGrid = false;
      const outlineM = f.pt.map((p) => {
        const m = toM(p);
        const sx = Math.round(m.x * 2) / 2;
        const sz = Math.round(m.z * 2) / 2;
        if (Math.abs(sx - m.x) > 0.15 || Math.abs(sz - m.z) > 0.15) offGrid = true;
        return offGrid ? { x: round3(m.x), z: round3(m.z) } : { x: sx, z: sz };
      });
      const norm = normalizeFootprint(outlineM);
      if (typeof norm === 'string') {
        excluded.push({ reason: `Unusable outline: ${norm}`, outlinePt: f.pt, texts: f.texts });
        continue;
      }
      // normalizeFootprint keeps the input's position when we add the offset back.
      const outline = norm.points.map((p) => ({ x: round3(p.x + norm.offset.x), z: round3(p.z + norm.offset.z) }));
      const openEdges = [...new Set(f.open.map((o, i) => (o ? norm.edgeMap.get(i) : undefined)).filter((e): e is number => e !== undefined))].sort((a, b) => a - b);
      // An edge the canonical outline merged keeps the majority role only if all merged parts agree.
      const area = round3(polygonArea(outline));
      const corners = outline.length;
      const shape: ExtractedStall['shape'] = corners === 4 ? 'rectangle' : corners === 6 ? 'L-shape' : 'polygon';
      if (outline.some((p) => Math.abs(p.x * 2 - Math.round(p.x * 2)) < 1e-9 && Math.abs(p.x - Math.round(p.x)) > 1e-9) ||
          outline.some((p) => Math.abs(p.z * 2 - Math.round(p.z * 2)) < 1e-9 && Math.abs(p.z - Math.round(p.z)) > 1e-9)) {
        cal.usesHalfMetres = true;
      }

      const letter = f.letters.length === 1 ? f.letters[0] : null;
      let include = true;
      if (f.letters.length > 1) {
        stallIssues.push({ code: 'MULTIPLE_LABELS', severity: 'error', message: `Several stall letters in one outline (${f.letters.join(', ')}): a partition line may be missing.` });
        include = false;
      }
      const areaLabel = f.areaLabels.length === 1 ? f.areaLabels[0] : null;
      if (f.areaLabels.length > 1) {
        stallIssues.push({ code: 'MULTIPLE_LABELS', severity: 'error', message: `Several area labels in one outline (${f.areaLabels.join(', ')} m²).` });
        include = false;
      }
      const words = f.texts.filter((t) => !LETTER.test(t) && !AREA.test(t) && !DIMS.test(t) && !BLOCK.test(t) && !STARTUP.test(t) && /[A-Za-z]{2,}/.test(t));
      if (!f.letters.length && words.length) {
        stallIssues.push({ code: 'NO_LABEL', severity: 'warning', message: `Named area "${words.join(' ')}", not a lettered stall; import it only if it should be bookable.` });
        include = false;
      } else if (!f.letters.length) {
        if (areaLabel === null && Math.abs(area - 12) <= 0.26) {
          stallIssues.push({ code: 'DEFAULT_AREA', severity: 'warning', message: 'No label: taken as a standard 12 m² stall (plan note: "all stalls are of 12 sqm, unless otherwise mentioned").' });
        } else {
          stallIssues.push({ code: 'NO_LABEL', severity: 'warning', message: 'No stall letter inside this outline; confirm it is a stall.' });
          include = false;
        }
      }
      if (areaLabel !== null) {
        const tolerance = Math.max(0.51, areaLabel * 0.01);
        if (Math.abs(areaLabel - area) > tolerance) {
          stallIssues.push({ code: 'AREA_MISMATCH', severity: 'error', message: `Label says ${areaLabel} m², the drawn outline measures ${area} m².` });
        } else if (Math.abs(areaLabel - area) > 1e-6) {
          stallIssues.push({ code: 'AREA_MISMATCH', severity: 'info', message: `Label ${areaLabel} m² is the rounded ${area} m² of the outline.` });
        }
      } else if (f.letters.length && Math.abs(area - 12) > 0.26) {
        stallIssues.push({ code: 'AREA_MISMATCH', severity: 'warning', message: `No area label, and the outline measures ${area} m², not the default 12 m².` });
      }
      for (const d of f.dims) {
        const bw = norm.width;
        const bl = norm.length;
        const err = Math.min(Math.abs(d.a - bw) + Math.abs(d.b - bl), Math.abs(d.a - bl) + Math.abs(d.b - bw));
        cal.dimensionChecks++;
        cal.dimensionMaxError = Math.max(cal.dimensionMaxError ?? 0, round3(err / 2));
        if (shape !== 'rectangle') {
          stallIssues.push({ code: 'DIMENSION_MISMATCH', severity: 'info', message: `Stated ${d.a} m × ${d.b} m on a ${shape}; its bounding box is ${bw} × ${bl} m.` });
        } else if (err > 0.26) {
          stallIssues.push({ code: 'DIMENSION_MISMATCH', severity: 'error', message: `Stated ${d.a} m × ${d.b} m, drawn ${bw} × ${bl} m.` });
        }
      }
      if (!openEdges.length) stallIssues.push({ code: 'NO_OPEN_EDGE', severity: 'warning', message: 'No fascia (open) edge found; choose the entrance before importing.' });
      if (offGrid) stallIssues.push({ code: 'OFF_GRID', severity: 'warning', message: 'Corners are not on the half-metre grid; the outline was kept as drawn.' });
      if (f.holes) stallIssues.push({ code: 'HOLE', severity: 'error', message: 'The outline encloses another shape; imported without it.' });
      if (f.diagonal) {
        stallIssues.push({ code: 'DIAGONAL_EDGE', severity: 'error', message: 'A diagonal line runs through this outline; diagonal partitions are not read. Check the shape.' });
        include = false;
      }
      if (!f.block) stallIssues.push({ code: 'NO_BLOCK', severity: 'warning', message: 'No block number found next to this stall.' });
      else if (f.blockInferred) stallIssues.push({ code: 'NO_BLOCK', severity: 'warning', message: `Block ${f.block} inferred from the nearest block number; confirm it.` });
      if (f.kiosk) {
        stallIssues.push({ code: 'KIOSK', severity: 'warning', message: 'Kiosk (e.g. ATM), not an exhibition stall.' });
        include = false;
      }

      const density = (n: number) => n / Math.max(area, 1);
      const category: ExtractedStall['category'] = f.startup
        ? 'start-up'
        : density(f.hatch.marquee) > 20
          ? 'marquee'
          : density(f.hatch.premium) > 20
            ? 'premium'
            : 'standard';
      const errors = stallIssues.filter((i) => i.severity === 'error').length;
      const warnings = stallIssues.filter((i) => i.severity === 'warning').length;
      const confidence: ExtractedStall['confidence'] = errors ? 'low' : warnings || !usedLayers || cal.rms > 0.1 ? 'medium' : 'high';
      stalls.push({
        key: '',
        group: g,
        blockId: f.block,
        letter,
        name: '',
        outline,
        openEdges,
        area,
        shape,
        category,
        labels: { area: areaLabel, dims: f.dims[0] ?? null, texts: f.texts },
        confidence,
        issues: stallIssues,
        include,
        outlinePt: f.pt.map((p) => ({ x: round3(p.x), z: round3(p.z) })),
      });
    }
    groups.push(cal);
  }

  // --- 9. names, duplicates -------------------------------------------------------------------------
  stalls.sort((a, b) => (a.group === b.group ? 0 : a.group < b.group ? -1 : 1) || (a.blockId ?? '~').localeCompare(b.blockId ?? '~') || (a.letter ?? '~').localeCompare(b.letter ?? '~'));
  const seen = new Map<string, number>();
  stalls.forEach((s, i) => {
    s.key = `s${i + 1}`;
    const words = s.labels.texts.filter((t) => !LETTER.test(t) && !AREA.test(t) && !DIMS.test(t) && !BLOCK.test(t) && /[A-Za-z]{2,}/.test(t));
    s.name = s.blockId && s.letter
      ? `${s.blockId} ${s.letter}`
      : !s.letter && words.length
        ? words.join(' ')
        : s.blockId
          ? `${s.blockId} (${s.key})`
          : `Stall ${s.key}`;
    seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  });
  for (const s of stalls) {
    if ((seen.get(s.name) ?? 0) > 1) {
      s.issues.push({ code: 'DUPLICATE_NAME', severity: 'error', message: `"${s.name}" appears more than once in the drawing (duplicate block number?).` });
      s.confidence = 'low';
    }
  }

  // Stall letters (and area labels) on the hall grid that no closed outline encloses.
  const unresolved: UnresolvedLabel[] = [];
  const inAnyFace = (x: number, y: number) =>
    faceList.some((f) => pointInPolygon({ x, z: y }, f.pt));
  const onHallGrid = (x: number, y: number) =>
    gridSegs.some((g) => Math.abs(g.x1 - g.x2) < 0.05 && Math.abs(g.x1 - x) < 1.5 * pitch && Math.min(g.y1, g.y2) <= y && Math.max(g.y1, g.y2) >= y) &&
    gridSegs.some((g) => Math.abs(g.y1 - g.y2) < 0.05 && Math.abs(g.y1 - y) < 1.5 * pitch && Math.min(g.x1, g.x2) <= x && Math.max(g.x1, g.x2) >= x);
  const orphans = texts.filter((t) => (LETTER.test(t.text) || AREA.test(t.text)) && !inAnyFace(t.x, t.y) && onHallGrid(t.x, t.y));
  const used = new Set<number>();
  orphans.forEach((t, i) => {
    if (used.has(i)) return;
    used.add(i);
    // A letter and its area label sit together: report them as one item.
    const mates = orphans
      .map((o, j) => ({ o, j }))
      .filter(({ o, j }) => !used.has(j) && Math.hypot(o.x - t.x, o.y - t.y) < 4 * pitch && LETTER.test(o.text) !== LETTER.test(t.text));
    const mate = mates.sort((a, b) => Math.hypot(a.o.x - t.x, a.o.y - t.y) - Math.hypot(b.o.x - t.x, b.o.y - t.y))[0];
    if (mate) used.add(mate.j);
    unresolved.push({
      texts: mate ? [t.text, mate.o.text] : [t.text],
      x: round3(t.x),
      y: round3(t.y),
      reason: 'This stall label has no closed outline around it (a partition or fascia line is missing in the drawing). Draw it in the planner if it is a stall.',
    });
  });
  if (unresolved.length) {
    issues.push(`${unresolved.length} stall label(s) have no closed outline in the drawing; they are listed for review, not guessed.`);
  }

  const detailIds = new Set(excluded.flatMap((e) => e.texts.filter((t) => BLOCK.test(t))));
  for (const id of detailIds) {
    if (stalls.some((s) => s.blockId === id)) issues.push(`Block ${id} also appears in a separate detail drawing; only the plan itself was imported.`);
  }
  if (groups.some((g) => g.usesHalfMetres)) {
    issues.push('Some stalls use half-metre dimensions: the imported layout needs a 0.5 m snap step.');
  }

  return {
    page: { width: page.width, height: page.height, rotation: page.rotation },
    layers,
    usedLayers,
    groups,
    stalls,
    excluded,
    unresolved,
    issues,
  };
}

// --- geometry helpers ---------------------------------------------------------------------------------

type Line = { c: number; lo: number; hi: number; open: boolean; parts: Array<{ lo: number; hi: number; open: boolean }> };

/** Group collinear pieces (coordinate within tol), merge those closer than `gap`. */
function mergeLines(raw: Array<{ c: number; lo: number; hi: number; open: boolean }>, tol: number, gap: number): Line[] {
  const sorted = [...raw].sort((a, b) => a.c - b.c);
  const clusters: Array<typeof raw> = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(r.c - last[last.length - 1].c) <= tol) last.push(r);
    else clusters.push([r]);
  }
  const out: Line[] = [];
  for (const cl of clusters) {
    const c = cl.reduce((s, r) => s + r.c, 0) / cl.length;
    const ivs = cl.map((r) => ({ lo: r.lo, hi: r.hi, open: r.open })).sort((a, b) => a.lo - b.lo);
    let cur: Line | null = null;
    for (const iv of ivs) {
      if (cur && iv.lo <= cur.hi + gap) {
        cur.hi = Math.max(cur.hi, iv.hi);
        cur.parts.push(iv);
      } else {
        if (cur) out.push(cur);
        cur = { c, lo: iv.lo, hi: iv.hi, open: iv.open, parts: [iv] };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Extend each line's ends up to `reach` to meet a perpendicular line (closes T-junction gaps). */
function extendToMeet(lines: Line[], perp: Line[], reach: number, tol: number): void {
  for (const l of lines) {
    const crossing = (at: number) => perp.some((p) => Math.abs(p.c - at) <= tol && l.c >= p.lo - tol && l.c <= p.hi + tol);
    if (!crossing(l.lo)) {
      const cand = perp.filter((p) => p.c < l.lo && p.c >= l.lo - reach && l.c >= p.lo - tol && l.c <= p.hi + tol).sort((a, b) => b.c - a.c)[0];
      if (cand) l.lo = cand.c;
    }
    if (!crossing(l.hi)) {
      const cand = perp.filter((p) => p.c > l.hi && p.c <= l.hi + reach && l.c >= p.lo - tol && l.c <= p.hi + tol).sort((a, b) => a.c - b.c)[0];
      if (cand) l.hi = cand.c;
    }
  }
}

/**
 * Closed faces of an axis-aligned line arrangement: every line coordinate and end becomes a grid
 * cut, a cell boundary is a wall where a line covers it, cells flood-fill into regions, regions
 * that reach the outside are dropped, and each region's boundary is traced into a ring.
 */
function traceFaces(h: Line[], v: Line[], tol: number): Array<{ outer: Point[]; holes: number }> {
  const cluster = (vals: number[]): number[] => {
    const s = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of s) if (!out.length || x - out[out.length - 1] > tol) out.push(x);
    return out;
  };
  const xs = cluster([...v.map((l) => l.c), ...h.flatMap((l) => [l.lo, l.hi])]);
  const ys = cluster([...h.map((l) => l.c), ...v.flatMap((l) => [l.lo, l.hi])]);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [];
  const idx = (arr: number[], val: number) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < val - tol) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // wallV[i][j]: wall on x = xs[i] between ys[j] and ys[j+1]; wallH[i][j]: on y = ys[j] between xs[i], xs[i+1].
  const wallV = new Uint8Array((nx + 1) * ny);
  const wallH = new Uint8Array(nx * (ny + 1));
  for (const l of v) {
    const i = idx(xs, l.c);
    for (let j = idx(ys, l.lo); j < ny && ys[j + 1] <= l.hi + tol; j++) wallV[i * ny + j] = 1;
  }
  for (const l of h) {
    const j = idx(ys, l.c);
    for (let i = idx(xs, l.lo); i < nx && xs[i + 1] <= l.hi + tol; i++) wallH[i * (ny + 1) + j] = 1;
  }
  const region = new Int32Array(nx * ny).fill(-1);
  const outside: boolean[] = [];
  let count = 0;
  for (let s = 0; s < nx * ny; s++) {
    if (region[s] >= 0) continue;
    const stack = [s];
    region[s] = count;
    let open = false;
    while (stack.length) {
      const k = stack.pop()!;
      const i = Math.floor(k / ny);
      const j = k % ny;
      const go = (ni: number, nj: number, blocked: boolean) => {
        if (blocked) return;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) { open = true; return; }
        const nk = ni * ny + nj;
        if (region[nk] < 0) { region[nk] = count; stack.push(nk); }
      };
      go(i - 1, j, wallV[i * ny + j] === 1);
      go(i + 1, j, wallV[(i + 1) * ny + j] === 1);
      go(i, j - 1, wallH[i * (ny + 1) + j] === 1);
      go(i, j + 1, wallH[i * (ny + 1) + j + 1] === 1);
    }
    outside.push(open);
    count++;
  }

  const faces: Array<{ outer: Point[]; holes: number }> = [];
  for (let r = 0; r < count; r++) {
    if (outside[r]) continue;
    const inR = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && region[i * ny + j] === r;
    const out = new Map<string, Point[]>();
    const add = (a: Point, b: Point) => {
      const k = `${a.x},${a.z}`;
      const list = out.get(k);
      if (list) list.push(b);
      else out.set(k, [b]);
    };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!inR(i, j)) continue;
        const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
        if (!inR(i, j - 1)) add({ x: x0, z: y0 }, { x: x1, z: y0 });
        if (!inR(i + 1, j)) add({ x: x1, z: y0 }, { x: x1, z: y1 });
        if (!inR(i, j + 1)) add({ x: x1, z: y1 }, { x: x0, z: y1 });
        if (!inR(i - 1, j)) add({ x: x0, z: y1 }, { x: x0, z: y0 });
      }
    }
    const rings: Point[][] = [];
    while (out.size) {
      const [startKey, targets] = out.entries().next().value as [string, Point[]];
      const [sx, sz] = startKey.split(',').map(Number);
      const ring: Point[] = [{ x: sx, z: sz }];
      let key = startKey;
      let list = targets;
      for (let guard = 0; guard < 100000; guard++) {
        const t = list.pop()!;
        if (!list.length) out.delete(key);
        if (t.x === sx && t.z === sz) break;
        ring.push(t);
        key = `${t.x},${t.z}`;
        const more = out.get(key);
        if (!more) break;
        list = more;
      }
      const simple = ring.filter((q, k) => {
        const p = ring[(k - 1 + ring.length) % ring.length];
        const n = ring[(k + 1) % ring.length];
        return Math.abs((q.x - p.x) * (n.z - q.z) - (q.z - p.z) * (n.x - q.x)) > 1e-9;
      });
      if (simple.length >= 3) rings.push(simple);
    }
    if (!rings.length) continue;
    rings.sort((a, b) => polygonArea(b) - polygonArea(a));
    faces.push({ outer: rings[0], holes: rings.length - 1 });
  }
  return faces;
}

/** Fraction of an outline edge drawn as fascia (open) rather than partition. */
function edgeOpenness(a: Point, b: Point, h: Line[], v: Line[], tol: number): number {
  const horizontal = Math.abs(a.z - b.z) <= tol;
  const lines = horizontal ? h : v;
  const c = horizontal ? a.z : a.x;
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.z, b.z);
  const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.z, b.z);
  let open = 0;
  let closed = 0;
  for (const l of lines) {
    if (Math.abs(l.c - c) > tol) continue;
    for (const p of l.parts) {
      const o = Math.max(0, Math.min(hi, p.hi) - Math.max(lo, p.lo));
      if (p.open) open += o;
      else closed += o;
    }
  }
  const len = Math.max(hi - lo, 1e-9);
  // A partition drawn over a fascia wins: the edge is closed.
  return closed >= 0.5 * len ? 0 : open / len;
}

/** Parallel facing edges at most `gap` apart, overlapping by at least `minLen`. */
function nearlyTouch(a: Point[], b: Point[], gap: number, minLen: number): boolean {
  const A = bounds(a);
  const B = bounds(b);
  const overlapX = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX);
  const overlapY = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY);
  const gapX = Math.max(A.minX - B.maxX, B.minX - A.maxX);
  const gapY = Math.max(A.minY - B.maxY, B.minY - A.maxY);
  return (overlapX >= minLen && gapY >= 0 && gapY <= gap) || (overlapY >= minLen && gapX >= 0 && gapX <= gap);
}

function shareEdge(a: Point[], b: Point[], tol: number, minLen: number): boolean {
  const ea = a.map((p, i) => [p, a[(i + 1) % a.length]] as const);
  const eb = b.map((p, i) => [p, b[(i + 1) % b.length]] as const);
  for (const [p, q] of ea) {
    for (const [r, s] of eb) {
      if (Math.abs(p.z - q.z) <= tol && Math.abs(r.z - s.z) <= tol && Math.abs(p.z - r.z) <= tol) {
        const o = Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x));
        if (o >= minLen) return true;
      }
      if (Math.abs(p.x - q.x) <= tol && Math.abs(r.x - s.x) <= tol && Math.abs(p.x - r.x) <= tol) {
        const o = Math.min(Math.max(p.z, q.z), Math.max(r.z, s.z)) - Math.max(Math.min(p.z, q.z), Math.min(r.z, s.z));
        if (o >= minLen) return true;
      }
    }
  }
  return false;
}

/** Most common grid spacing (points per metre), from consecutive distinct grid-line positions. */
export function globalPitch(vs: number[], hs: number[]): number | null {
  const diffs: number[] = [];
  for (const arr of [vs, hs]) {
    const s = [...new Set(arr.map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      const d = s[i] - s[i - 1];
      if (d > 1 && d < 60) diffs.push(d);
    }
  }
  if (diffs.length < 5) return null;
  // Histogram at 0.25 pt, then the mean of the diffs within ±4 % of the busiest bin.
  const bins = new Map<number, number>();
  for (const d of diffs) bins.set(Math.round(d * 4), (bins.get(Math.round(d * 4)) ?? 0) + 1);
  const [peak] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
  const centre = peak / 4;
  const near = diffs.filter((d) => Math.abs(d - centre) <= centre * 0.04);
  return near.reduce((s, d) => s + d, 0) / near.length;
}

/**
 * The lattice origin for a known pitch: circular mean of the lines' phases, then refined over
 * the lines within 10 % of a pitch of it (off-lattice lines, e.g. a neighbouring hall's grid,
 * are left out). RMS is in points.
 */
export function fitOrigin(values: number[], pitch: number): { pitch: number; origin: number; rms: number; used: number } {
  const vals = [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  if (!vals.length) return { pitch, origin: 0, rms: 0, used: 0 };
  const phase = (list: number[], base: number) => {
    let sx = 0;
    let sy = 0;
    for (const v of list) {
      const t = (2 * Math.PI * (v - base)) / pitch;
      sx += Math.cos(t);
      sy += Math.sin(t);
    }
    return base + (Math.atan2(sy, sx) / (2 * Math.PI)) * pitch;
  };
  const base = vals[0];
  let origin = phase(vals, base);
  let inliers = vals;
  for (let pass = 0; pass < 3; pass++) {
    inliers = vals.filter((v) => Math.abs(v - (origin + Math.round((v - origin) / pitch) * pitch)) <= 0.1 * pitch);
    if (!inliers.length) break;
    origin = phase(inliers, base);
  }
  const res = inliers.map((v) => v - (origin + Math.round((v - origin) / pitch) * pitch));
  const rms = res.length ? Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) : 0;
  return { pitch, origin, rms, used: inliers.length };
}

/** Fit positions = origin + pitch * k (integer k), rejecting off-lattice lines. */
export function fitLattice(values: number[], guess: number): { pitch: number; origin: number; rms: number; used: number } {
  const vals = [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  if (vals.length < 3) return { pitch: guess, origin: vals[0] ?? 0, rms: 0, used: vals.length };
  let best = { pitch: guess, origin: vals[0], rms: Infinity, used: 0 };
  for (let step = -300; step <= 300; step++) {
    const p = guess * (1 + step * 0.0001);
    const base = vals[Math.floor(vals.length / 2)];
    // Circular mean of the phases gives the origin for this pitch.
    let sx = 0;
    let sy = 0;
    for (const v of vals) {
      const t = (2 * Math.PI * (v - base)) / p;
      sx += Math.cos(t);
      sy += Math.sin(t);
    }
    const origin = base + (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
    const res = vals.map((v) => v - (origin + Math.round((v - origin) / p) * p));
    const inl = res.filter((r) => Math.abs(r) <= 0.2 * p);
    if (inl.length < vals.length * 0.6) continue;
    const rms = Math.sqrt(inl.reduce((s, r) => s + r * r, 0) / inl.length);
    // Prefer more lines on the lattice, then the lower residual.
    if (inl.length > best.used || (inl.length === best.used && rms < best.rms)) best = { pitch: p, origin, rms, used: inl.length };
  }
  return best.rms === Infinity ? { pitch: guess, origin: vals[0], rms: 0, used: 0 } : best;
}

function bounds(ps: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...ps.map((p) => p.x)),
    maxX: Math.max(...ps.map((p) => p.x)),
    minY: Math.min(...ps.map((p) => p.z)),
    maxY: Math.max(...ps.map((p) => p.z)),
  };
}

function rectDistance(p: Point, b: { minX: number; maxX: number; minY: number; maxY: number }): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.z, 0, p.z - b.maxY);
  return Math.hypot(dx, dy);
}

function centroidOf(ps: Point[]): Point {
  return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, z: ps.reduce((s, p) => s + p.z, 0) / ps.length };
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < a.x + ((p.z - a.z) * (b.x - a.x)) / (b.z - a.z)) inside = !inside;
  }
  return inside;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
