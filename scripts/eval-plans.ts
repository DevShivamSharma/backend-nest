/**
 * Measures the plan import against fixtures whose truth is known independently of the
 * importer:
 *
 *  - synthetic plans (scripts/build-plan-fixtures.ts): truth is the drawn scene;
 *  - real ITPO plans (test/fixtures/plans/itpo/cases.json): facts printed on each plan, read
 *    by a person, plus ITPO's own layout of the hall as a comparison reference (not as truth:
 *    those layouts are hand-drawn).
 *
 *   npm run eval:plans                  every case
 *   npm run eval:plans -- --only=single text filter on the case name
 *   npm run eval:plans -- --skip-ocr    faster; cases that need OCR'd words are reported as such
 *
 * Exits 1 when any assertion fails. Thresholds and their reasons live with each case.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlanTextReading } from '../src/ai/plan-text-reader.service';
import { ruleKind } from '../src/ai/plan-texts';
import { DrawingAnalysis, runDrawingAnalysis } from '../src/integrations/drawings/drawing-analysis';
import { itpoRowToFloor, readItpoHallRows } from '../src/integrations/itpo/itpo-hall-layout';
import { blocksStalls, HallFloor } from '../src/venues/floor/hall-floor';
import { stallMask } from '../src/venues/plan-import/floor-diff';
import { emptyReviewState, HallReview, reviewImport, ReviewState, SheetReview } from '../src/venues/plan-import/review';

const ROOT = join(__dirname, '../test/fixtures/plans');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const skipOcr = args.includes('--skip-ocr');

type Rect = { x: number; y: number; w: number; h: number };

interface SyntheticTruth {
  case: string;
  file: string;
  source: string;
  sheet: { width: number; height: number };
  gridMetres: number | null;
  halls: Array<{
    name: string;
    page: number;
    floor: Rect[];
    bands: Array<{ kind: string; color: string; rect: Rect }>;
    voids: Rect[];
    foyer: Rect[];
    printed?: { width?: number; depth?: number };
  }>;
  sharedFoyer?: Rect[];
  legend: Record<string, string>;
  expect: {
    halls?: number;
    scaleStatus?: string[];
    sharedFoyerUndecided?: boolean;
    separationIssue?: boolean;
    cutAtX?: number;
    rotation?: number;
    mapSource?: string;
    boundaryCheck?: string;
    duplicateOnPage?: number;
  };
}

interface ItpoCase {
  name: string;
  file: string;
  /** Who read the plan for these facts, and when. */
  readBy: string;
  humanVerified: boolean;
  needsOcr: boolean;
  expect: {
    halls: Array<{ name: string; foyer?: boolean }>;
    statedGridMetres?: number;
    /** Colour family -> kind, as the plan's legend states it. */
    legend?: Record<string, string>;
  };
  reference?: {
    itpoHallId: string;
    hall: string;
    minIoU: number;
    why: string;
  };
}

interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

/** Rules only: the model is not deterministic enough for a regression check. */
function ruleReadings(analysis: DrawingAnalysis): Map<string, PlanTextReading> {
  const readings = new Map<string, PlanTextReading>();
  for (const sheet of analysis.sheets) {
    for (const t of sheet.texts) {
      const key = t.text.replace(/\s+/g, ' ').trim();
      const kind = ruleKind(key);
      readings.set(key, kind ? { kind, by: 'rules', review: false } : { kind: 'none', by: 'default', review: false });
    }
  }
  return readings;
}

// ---- geometry -------------------------------------------------------------------------------

const RES = 0.1;

class Mask {
  readonly m: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.m = new Uint8Array(w * h);
  }
  paint(r: Rect, value: 0 | 1, dx = 0, dy = 0): void {
    const c0 = Math.max(0, Math.round((r.x + dx) / RES));
    const c1 = Math.min(this.w, Math.round((r.x + r.w + dx) / RES));
    const r0 = Math.max(0, Math.round((r.y + dy) / RES));
    const r1 = Math.min(this.h, Math.round((r.y + r.h + dy) / RES));
    for (let y = r0; y < r1; y++) if (c0 < c1) this.m.fill(value, y * this.w + c0, y * this.w + c1);
  }
  count(): number {
    let n = 0;
    for (const v of this.m) n += v;
    return n;
  }
}

function iou(a: Mask, b: Mask, dx = 0, dy = 0): number {
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const va = a.m[y * a.w + x];
      const bx = x - dx;
      const by = y - dy;
      const vb = bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.m[by * b.w + bx] : 0;
      na += va;
      nb += vb;
      if (va && vb) inter++;
    }
  }
  return na + nb - inter ? inter / (na + nb - inter) : 1;
}

/** The hall's stall floor, foyer excluded, painted in sheet metres. */
function ourStallFloor(hall: HallReview, origin: { x: number; y: number }, sheet: { width: number; height: number }): Mask {
  const mask = new Mask(Math.ceil(sheet.width / RES), Math.ceil(sheet.height / RES));
  const f = hall.floor;
  const ox = (f.placement?.x ?? 0) + origin.x;
  const oy = (f.placement?.y ?? 0) + origin.y;
  const local = stallMask(f, RES);
  for (let y = 0; y < local.h; y++) {
    for (let x = 0; x < local.w; x++) {
      if (!local.m[y * local.w + x]) continue;
      const sx = Math.round(ox / RES) + x;
      const sy = Math.round(oy / RES) + y;
      if (sx >= 0 && sy >= 0 && sx < mask.w && sy < mask.h) mask.m[sy * mask.w + sx] = 1;
    }
  }
  for (const z of f.zones ?? []) {
    if (z.kind !== 'foyer') continue;
    for (const r of z.rects) mask.paint({ x: r.x, y: r.y, w: r.width, h: r.height }, 0, ox, oy);
  }
  return mask;
}

function truthStallFloor(h: SyntheticTruth['halls'][number], sheet: { width: number; height: number }): Mask {
  const mask = new Mask(Math.ceil(sheet.width / RES), Math.ceil(sheet.height / RES));
  for (const r of h.floor) mask.paint(r, 1);
  for (const b of h.bands) if (blocksStalls(b.kind as never)) mask.paint(b.rect, 0);
  for (const v of h.voids) mask.paint(v, 0);
  for (const f of h.foyer) mask.paint(f, 0);
  return mask;
}

/** Where map unit (0, 0) of a sheet lies, in sheet metres (the picture spans the sheet). */
function mapOrigin(analysis: DrawingAnalysis, page: number, mpu: number): { x: number; y: number } {
  const s = analysis.sheets.find((x) => x.page === page)!;
  return {
    x: (s.preview.originX / s.preview.unitPxX) * mpu,
    y: (s.preview.originY / s.preview.unitPxY) * mpu,
  };
}

/** Best IoU over small shifts (for turned scans, whose sheet frame changes when squared up). */
function bestShiftIoU(a: Mask, b: Mask, range: number): { iou: number; dx: number; dy: number } {
  let best = { iou: 0, dx: 0, dy: 0 };
  const step = 5;
  for (let dy = -range; dy <= range; dy += step) {
    for (let dx = -range; dx <= range; dx += step) {
      const v = iou(a, b, dx, dy);
      if (v > best.iou) best = { iou: v, dx, dy };
    }
  }
  for (let dy = best.dy - step; dy <= best.dy + step; dy++) {
    for (let dx = best.dx - step; dx <= best.dx + step; dx++) {
      const v = iou(a, b, dx, dy);
      if (v > best.iou) best = { iou: v, dx, dy };
    }
  }
  return best;
}

// ---- synthetic cases ------------------------------------------------------------------------

/**
 * Drawable IoU thresholds, from the plan's resolution: a raster edge is certain to about one
 * pixel, so the area in doubt is the perimeter times a pixel. At 10 px/m on a 60 x 40 m hall
 * that is 200 m x 0.1 m = 20 m² of 2,400 m², about 0.8%: 0.99 holds. A vector drawing has no
 * pixel doubt: 0.99 is the stated target. A turned scan is resampled once more (one pixel more
 * of doubt): 0.98. A floor read from walls instead of a grid can lose a pixel row at each wall
 * face: 0.97.
 */
function iouThreshold(t: SyntheticTruth): { min: number; why: string } {
  if (t.expect.rotation) return { min: 0.98, why: 'turned scan at 10 px/m: two resamplings' };
  if (t.expect.mapSource === 'outline') return { min: 0.97, why: 'floor from wall faces at 10 px/m' };
  if (t.file.endsWith('.jpg')) return { min: 0, why: 'uncertain scan: geometry not asserted' };
  return { min: 0.99, why: t.file.endsWith('.png') ? 'scan at 10 px/m' : 'vector drawing' };
}

async function syntheticCase(file: string): Promise<{ name: string; assertions: Assertion[] }> {
  const truth = JSON.parse(readFileSync(join(ROOT, 'synthetic', file), 'utf8')) as SyntheticTruth;
  const assertions: Assertion[] = [];
  const check = (name: string, ok: boolean, detail: string) => assertions.push({ name, ok, detail });
  const outcome = await runDrawingAnalysis({
    data: new Uint8Array(readFileSync(join(ROOT, 'synthetic', truth.file))),
    fileName: truth.file,
    readScannedText: !skipOcr,
  });
  if (!outcome.ok) {
    check('reads', false, outcome.message);
    return { name: truth.case, assertions };
  }
  const analysis = outcome.analysis;
  const readings = ruleReadings(analysis);
  const state: ReviewState = emptyReviewState();
  let review = reviewImport(analysis, readings, state);

  // The reviewer's correction for a floor that carries two halls: one cut.
  if (truth.expect.cutAtX !== undefined) {
    const before = review[0].halls.find((h) => h.checks.some((c) => c.id === 'separation' && c.status === 'fail'));
    check('separation flagged', Boolean(before), before ? `"${before.name}" carries two titles` : 'no separation issue raised');
    const sheet = review[0];
    const mpu = sheet.metresPerUnit;
    const origin = mapOrigin(analysis, 1, mpu);
    const x = truth.expect.cutAtX / mpu - origin.x / mpu;
    state.cuts[1] = [{ x, y: -1000, width: 10000, height: 3000 }];
    review = reviewImport(analysis, readings, state);
  }

  const sheets = review;
  const all = sheets.flatMap((s) => s.halls);
  const distinct = all.filter((h) => !h.duplicateOf);
  const truthDistinct = truth.expect.duplicateOnPage ? truth.halls.length - 1 : truth.halls.length;
  check('hall count', distinct.length === truthDistinct, `found ${distinct.length} (${all.map((h) => h.name || '?').join(', ')}), drawn ${truthDistinct}`);

  if (truth.expect.duplicateOnPage) {
    const dup = all.find((h) => h.page === truth.expect.duplicateOnPage && h.duplicateOf);
    check('repeat on a later page marked', Boolean(dup), dup ? `${dup.name} on page ${dup.page}` : 'not marked');
  }

  const sheet0: SheetReview = sheets[0];
  if (truth.expect.scaleStatus) {
    check('scale status', truth.expect.scaleStatus.includes(sheet0.scale.status), `${sheet0.scale.status} (expected ${truth.expect.scaleStatus.join(' or ')}): ${sheet0.scale.note}`);
  }
  if (truth.gridMetres && sheet0.scale.metresPerUnit && analysis.sheets[0].map.source === 'grid') {
    const err = Math.abs(sheet0.scale.metresPerUnit - truth.gridMetres) / truth.gridMetres;
    check('grid size', err <= 0.01, `${sheet0.scale.metresPerUnit.toFixed(4)} m per cell, drawn ${truth.gridMetres} m`);
  }
  if (truth.expect.rotation !== undefined) {
    const got = analysis.sheets[0].rotation;
    check('turn found', Math.abs(Math.abs(got) - truth.expect.rotation) <= 0.3, `${got.toFixed(2)}°, drawn ${truth.expect.rotation}°`);
  }
  if (truth.expect.mapSource) {
    check('floor source', analysis.sheets[0].map.source === truth.expect.mapSource, analysis.sheets[0].map.source);
  }
  if (truth.expect.sharedFoyerUndecided) {
    const flagged = all.filter((h) => h.checks.some((c) => c.id.startsWith('shared') && c.status === 'fail'));
    const foyerInHalls = all.reduce((n, h) => n + h.stats.foyer, 0);
    check('shared foyer left to the person', flagged.length >= 2 && foyerInHalls === 0, `${flagged.length} halls flag it; foyer counted in halls: ${foyerInHalls} m²`);
  }

  // Per hall: name, geometry, bands, printed size, legend.
  const scaleKnown = sheet0.scale.metresPerUnit !== null || truth.gridMetres === null;
  for (const t of truth.halls.filter((h, i) => !(truth.expect.duplicateOnPage && i > 0))) {
    const ours =
      all.find((h) => h.page === t.page && h.name.toLowerCase() === t.name.toLowerCase()) ??
      (all.length === 1 ? all[0] : undefined);
    if (!ours) {
      check(`${t.name}: found`, false, 'no hall of that name');
      continue;
    }
    check(`${t.name}: name`, ours.name.toLowerCase() === t.name.toLowerCase(), `"${ours.name}"`);
    const s = sheets.find((x) => x.page === t.page)!;
    const threshold = iouThreshold(truth);
    if (threshold.min > 0 && scaleKnown) {
      const mpu = s.metresPerUnit;
      const ourMask = ourStallFloor(ours, mapOrigin(analysis, t.page, mpu), truth.sheet);
      const truthMask = truthStallFloor(t, truth.sheet);
      const measured = truth.expect.rotation ? bestShiftIoU(truthMask, ourMask, 40).iou : iou(truthMask, ourMask);
      check(`${t.name}: drawable IoU`, measured >= threshold.min, `${(measured * 100).toFixed(2)}% (min ${threshold.min * 100}%: ${threshold.why})`);
    }
    for (const kind of [...new Set(t.bands.map((b) => b.kind))]) {
      const want = t.bands.filter((b) => b.kind === kind).reduce((n, b) => n + b.rect.w * b.rect.h, 0);
      const got = ours.stats.bands.filter((b) => b.kind === kind).reduce((n, b) => n + b.area, 0);
      const ok = Math.abs(got - want) <= Math.max(0.05 * want, 1);
      check(`${t.name}: ${kind} area`, ok, `${got.toFixed(1)} m², drawn ${want.toFixed(1)} m² (±5%)`);
    }
    for (const v of t.voids) {
      check(`${t.name}: void`, Math.abs(ours.stats.voids - v.w * v.h) <= 0.1 * v.w * v.h, `${ours.stats.voids} m², drawn ${v.w * v.h} m²`);
    }
    if (t.printed && scaleKnown) {
      const dims = ours.checks.filter((c) => c.id.startsWith('dimension-'));
      const passed = dims.filter((c) => c.status === 'pass');
      check(`${t.name}: printed dimensions checked`, passed.length >= 1 && passed.length === dims.length, dims.map((c) => `${c.label} ${c.status} (${c.expected} vs ${c.measured})`).join('; ') || 'none read');
    }
    if (truth.expect.boundaryCheck) {
      const b = ours.checks.find((c) => c.id === 'boundary');
      check(`${t.name}: boundary to confirm`, b?.status === truth.expect.boundaryCheck, b ? b.status : 'no boundary check');
    }
  }
  for (const [color, kind] of Object.entries(truth.legend)) {
    const group = sheet0.groups
      .map((g) => ({ g, d: distance(g.color, color) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!group || group.d > 60) continue; // that colour is not on the floor
    check(`legend ${color} -> ${kind}`, group.g.choice === kind && group.g.from === 'legend', `${group.g.choice} (from ${group.g.from}${group.g.legend ? `: "${group.g.legend}"` : ''})`);
  }
  return { name: truth.case, assertions };
}

function distance(a: string, b: string): number {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
}

// ---- ITPO cases -----------------------------------------------------------------------------

async function itpoCase(c: ItpoCase): Promise<{ name: string; assertions: Assertion[] }> {
  const assertions: Assertion[] = [];
  const check = (name: string, ok: boolean, detail: string) => assertions.push({ name, ok, detail });
  const path = join(ROOT, 'itpo', c.file);
  if (!existsSync(path)) {
    check('fixture present', false, `missing ${c.file}`);
    return { name: c.name, assertions };
  }
  if (skipOcr && c.needsOcr) {
    return { name: `${c.name} (skipped: needs OCR)`, assertions };
  }
  const outcome = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(path)), fileName: c.file, readScannedText: true });
  if (!outcome.ok) {
    check('reads', false, outcome.message);
    return { name: c.name, assertions };
  }
  const review = reviewImport(outcome.analysis, ruleReadings(outcome.analysis), emptyReviewState());
  const halls = review.flatMap((s) => s.halls);
  for (const e of c.expect.halls) {
    const h = halls.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
    check(`${e.name}: found`, Boolean(h), h ? `${h.stats.width} × ${h.stats.depth} m` : `found: ${halls.map((x) => x.name || '?').join(', ')}`);
    if (h && e.foyer !== undefined) {
      check(`${e.name}: foyer`, (h.stats.foyer > 0) === e.foyer, `${h.stats.foyer} m² foyer`);
    }
  }
  const sheet = outcome.analysis.sheets[0];
  if (c.expect.statedGridMetres !== undefined) {
    check('grid size read', sheet.statedGrid?.metres === c.expect.statedGridMetres, sheet.statedGrid ? `"${sheet.statedGrid.text}"` : 'not read');
  }
  for (const [family, kind] of Object.entries(c.expect.legend ?? {})) {
    const g = review[0].groups.find((x) => x.family === family);
    check(`legend ${family} -> ${kind}`, g?.choice === kind && g.from === 'legend', g ? `${g.choice} (from ${g.from}${g.legend ? `: "${g.legend}"` : ''})` : 'colour not on the floor');
  }
  if (c.reference) {
    const h = halls.find((x) => x.name.toLowerCase() === c.reference!.hall.toLowerCase());
    const ref = referenceFloor(c.reference.itpoHallId);
    if (h && ref) {
      const v = orientedIoU(h.floor, ref);
      check(`${c.reference.hall}: IoU vs ITPO layout ${c.reference.itpoHallId} (reference)`, v >= c.reference.minIoU, `${(v * 100).toFixed(1)}% (min ${c.reference.minIoU * 100}%: ${c.reference.why})`);
    }
  }
  return { name: c.name, assertions };
}

function referenceFloor(hallId: string): HallFloor | null {
  const file = join(ROOT, 'itpo', 'T_HALL_LAYOUTS.reference.csv');
  if (!existsSync(file)) return null;
  const row = readItpoHallRows(readFileSync(file, 'utf8'), 'csv').find((r) => r.hallId === hallId);
  return row ? itpoRowToFloor(row).floor : null;
}

/** Drawable IoU of two floors on a 1 m raster, over the 8 orientations and small shifts. */
function orientedIoU(a: HallFloor, b: HallFloor): number {
  const ma = stallMask(a, 1);
  const mb0 = stallMask(b, 1);
  let best = 0;
  for (let k = 0; k < 8; k++) {
    const mb = orient(mb0, k);
    for (let dy = -15; dy <= 15; dy++) {
      for (let dx = -15; dx <= 15; dx++) {
        let inter = 0;
        let na = 0;
        let nb = 0;
        for (let y = 0; y < Math.max(ma.h, mb.h + dy); y++) {
          for (let x = 0; x < Math.max(ma.w, mb.w + dx); x++) {
            const va = x < ma.w && y < ma.h ? ma.m[y * ma.w + x] : 0;
            const bx = x - dx;
            const by = y - dy;
            const vb = bx >= 0 && by >= 0 && bx < mb.w && by < mb.h ? mb.m[by * mb.w + bx] : 0;
            na += va;
            nb += vb;
            if (va && vb) inter++;
          }
        }
        const v = na + nb - inter ? inter / (na + nb - inter) : 0;
        if (v > best) best = v;
      }
    }
  }
  return best;
}

function orient(m: { w: number; h: number; m: Uint8Array }, k: number): { w: number; h: number; m: Uint8Array } {
  const { w, h } = m;
  const swap = k % 2 === 1;
  const out = { w: swap ? h : w, h: swap ? w : h, m: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = k >= 4 ? w - 1 - x : x;
      const Y = y;
      let nx = X;
      let ny = Y;
      const r = k % 4;
      if (r === 1) [nx, ny] = [h - 1 - Y, X];
      else if (r === 2) [nx, ny] = [w - 1 - X, h - 1 - Y];
      else if (r === 3) [nx, ny] = [Y, w - 1 - X];
      out.m[ny * out.w + nx] = m.m[y * w + x];
    }
  }
  return out;
}

// ---- main -----------------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const results: Array<{ name: string; assertions: Assertion[] }> = [];
  const synthetic = JSON.parse(readFileSync(join(ROOT, 'synthetic', 'index.json'), 'utf8')) as string[];
  for (const file of synthetic) {
    if (only && !file.includes(only)) continue;
    results.push(await syntheticCase(file));
  }
  const itpoIndex = join(ROOT, 'itpo', 'cases.json');
  if (existsSync(itpoIndex)) {
    for (const c of JSON.parse(readFileSync(itpoIndex, 'utf8')) as ItpoCase[]) {
      if (only && !c.name.includes(only)) continue;
      results.push(await itpoCase(c));
    }
  }

  let failed = 0;
  let total = 0;
  for (const r of results) {
    const bad = r.assertions.filter((a) => !a.ok).length;
    console.log(`\n${bad ? '✗' : '✓'} ${r.name}`);
    for (const a of r.assertions) {
      total++;
      if (!a.ok) failed++;
      console.log(`   ${a.ok ? 'pass' : 'FAIL'}  ${a.name}: ${a.detail}`);
    }
  }
  console.log(`\n${total - failed}/${total} assertions passed in ${results.length} cases, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
