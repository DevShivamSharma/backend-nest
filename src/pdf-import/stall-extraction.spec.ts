import type { PageVectors, VectorPath, VectorSegment } from './pdf-vectors';
import { extractStalls, fitOrigin, globalPitch, stallLayerModes } from './stall-extraction';

/*
 * Synthetic CAD plans, built the way AutoCAD exports them: a 1 m grid on layer GRID, stall
 * partitions on PARTITION (red, 1.44 pt), fascia on FACIA (magenta, drawn as 0.5 m dashes),
 * labels as text. 1 m = 10 pt; the hall's grid starts at (100, 100) pt.
 */
const M = 10;
const O = 100;
const pt = (m: number) => O + m * M;
const seg = (x1: number, y1: number, x2: number, y2: number): VectorSegment => ({
  x1: pt(x1),
  y1: pt(y1),
  x2: pt(x2),
  y2: pt(y2),
});
const path = (
  layer: string,
  stroke: string,
  width: number,
  segments: VectorSegment[],
): VectorPath => ({ layer, stroke, fill: null, width, segments });

function grid(w: number, h: number, dx = 0, dy = 0): VectorPath {
  const s: VectorSegment[] = [];
  for (let x = 0; x <= w; x++) s.push(seg(x + dx, dy, x + dx, h + dy));
  for (let y = 0; y <= h; y++) s.push(seg(dx, y + dy, w + dx, y + dy));
  return path('GRID', '#adadad', 0.6, s);
}
/** A dashed line (0.5 m dash, 0.25 m gap) along an axis-aligned segment. */
function dashed(x1: number, y1: number, x2: number, y2: number): VectorSegment[] {
  const out: VectorSegment[] = [];
  const len = Math.hypot(x2 - x1, y2 - y1);
  for (let t = 0; t < len; t += 0.75) {
    const e = Math.min(t + 0.5, len);
    out.push(
      seg(
        x1 + ((x2 - x1) * t) / len,
        y1 + ((y2 - y1) * t) / len,
        x1 + ((x2 - x1) * e) / len,
        y1 + ((y2 - y1) * e) / len,
      ),
    );
  }
  return out;
}
const partition = (...s: VectorSegment[]) => path('PARTITION', '#ff0000', 1.44, s);
const facia = (...s: VectorSegment[]) => path('FACIA', '#ff00ff', 1.08, s);
const text = (t: string, x: number, y: number) => ({
  text: t,
  x: pt(x),
  y: pt(y),
  size: 7,
  vertical: false,
});

function page(paths: VectorPath[], texts: PageVectors['texts']): PageVectors {
  return {
    width: 1000,
    height: 800,
    rotation: 0,
    paths,
    texts,
    layers: [...new Set(paths.map((p) => p.layer))],
    pageCount: 1,
  };
}

/**
 * Block 01-02 on a 30 x 20 m grid:
 *   L-shaped stall C: top arm x 2..9 z 2..5 plus right arm x 6..9 z 5..8 (30 m²), notch left,
 *     partitions on its top and right, fascia along the notch edges.
 *   Rectangle D: x 9..12, z 2..6 (12 m², unlabelled area -> default), partition all round
 *     except its bottom (fascia).
 */
function blockPlan(
  extra: { paths?: VectorPath[]; texts?: PageVectors['texts'] } = {},
): PageVectors {
  return page(
    [
      grid(30, 20),
      // L: closed top and right sides.
      partition(seg(2, 2, 9, 2), seg(9, 2, 9, 8)),
      // L: open sides (bottom of the right arm, the two notch edges, the left end).
      facia(
        ...dashed(9, 8, 6, 8),
        ...dashed(6, 8, 6, 5),
        ...dashed(6, 5, 2, 5),
        ...dashed(2, 5, 2, 2),
      ),
      // D next to it, sharing x = 9.
      partition(seg(9, 2, 12, 2), seg(12, 2, 12, 6)),
      facia(...dashed(12, 6, 9, 6)),
      ...(extra.paths ?? []),
    ],
    [
      text('C', 3, 3),
      text('30m²', 5, 3.5),
      text('D', 10.5, 3),
      text('01-02', 11, 9),
      ...(extra.texts ?? []),
    ],
  );
}

describe('extractStalls', () => {
  it('measures the metre from the 1 m grid', () => {
    const g = grid(20, 10).segments;
    expect(
      globalPitch(
        g.filter((s) => s.x1 === s.x2).map((s) => s.x1),
        g.filter((s) => s.y1 === s.y2).map((s) => s.y1),
      ),
    ).toBeCloseTo(10, 6);
    expect(fitOrigin([103, 113, 123, 133, 147.5], 10)).toEqual(
      expect.objectContaining({ origin: expect.closeTo(103, 6), used: 4 }),
    );
  });

  it('extracts an L-shaped stall as ONE six-corner outline with its notch empty', () => {
    const r = extractStalls(blockPlan());
    const c = r.stalls.find((s) => s.letter === 'C')!;
    expect(c).toBeDefined();
    expect(c.shape).toBe('L-shape');
    expect(c.outline.length).toBe(6);
    expect(c.area).toBe(30);
    expect(c.name).toBe('01-02 C');
    expect(c.group).toBe('1');
    // In whole grid metres (the group's origin is a grid line; registration to the hall is
    // done at review): the arms exactly as drawn.
    const x0 = Math.min(...c.outline.map((p) => p.x));
    const z0 = Math.min(...c.outline.map((p) => p.z));
    expect(c.outline.map((p) => ({ x: p.x - x0, z: p.z - z0 }))).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0 },
        { x: 7, z: 0 },
        { x: 7, z: 6 },
        { x: 4, z: 6 },
        { x: 4, z: 3 },
        { x: 0, z: 3 },
      ]),
    );
    expect(c.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('reads open edges from the fascia layer and closed ones from the partitions', () => {
    const c = extractStalls(blockPlan()).stalls.find((s) => s.letter === 'C')!;
    const open = c.openEdges.map((i) => [c.outline[i], c.outline[(i + 1) % c.outline.length]]);
    // The two closed sides (top z = 2 from x 2 to 9, right x = 9) are never open.
    for (const [a, b] of open) {
      expect(a.z === 2 && b.z === 2).toBe(false);
      expect(a.x === 9 && b.x === 9).toBe(false);
    }
    expect(c.openEdges.length).toBe(4);
  });

  it('accepts a lettered 12 m² outline without an area label (the plan default)', () => {
    const d = extractStalls(blockPlan()).stalls.find((s) => s.letter === 'D')!;
    expect(d.area).toBe(12);
    expect(d.shape).toBe('rectangle');
    expect(d.confidence).toBe('high');
    expect(d.issues).toEqual([]);
  });

  it('takes an outline with no letter at all as a default stall, with a warning', () => {
    const plan = blockPlan();
    plan.texts = plan.texts.filter((t) => t.text !== 'D');
    const d = extractStalls(plan).stalls.find((s) => s.area === 12)!;
    expect(d.letter).toBeNull();
    expect(d.confidence).toBe('medium');
    expect(d.issues.map((i) => i.code)).toContain('DEFAULT_AREA');
  });

  it('never turns grid or annotation lines into stalls', () => {
    const r = extractStalls(
      blockPlan({
        paths: [
          path('DIM', '#000000', 0.5, [
            seg(15, 10, 25, 10),
            seg(15, 9, 15, 11),
            seg(25, 9, 25, 11),
          ]),
        ],
        texts: [text('10m', 20, 9.5)],
      }),
    );
    expect(r.stalls.length).toBe(2);
  });

  it('flags an area label that disagrees with the drawn outline', () => {
    const r = extractStalls(blockPlan({ texts: [text('14m²', 10.5, 4)] }));
    const d = r.stalls.find((s) => s.letter === 'D')!;
    expect(d.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AREA_MISMATCH', severity: 'error' }),
      ]),
    );
    expect(d.confidence).toBe('low');
  });

  it('excludes a separate detail drawing that is not on the hall grid', () => {
    const r = extractStalls(
      blockPlan({
        paths: [
          partition(seg(40, 2, 47, 2), seg(47, 2, 47, 8), seg(47, 8, 40, 8), seg(40, 8, 40, 2)),
        ],
        texts: [text('C', 42, 4), text('01-02', 45, 7)],
      }),
    );
    expect(r.stalls.filter((s) => s.letter === 'C').length).toBe(1);
    expect(r.excluded.length).toBe(1);
    expect(r.issues.join(' ')).toContain('detail drawing');
  });

  it('reports a stall label without a closed outline instead of guessing one', () => {
    // Stall E: two partitions and a fascia, but its fourth side is missing.
    const r = extractStalls(
      blockPlan({
        paths: [partition(seg(14, 2, 18, 2), seg(18, 2, 18, 5)), facia(...dashed(18, 5, 14, 5))],
        texts: [text('E', 16, 3.5), text('12m²', 16, 4.2)],
      }),
    );
    expect(r.stalls.some((s) => s.letter === 'E')).toBe(false);
    expect(r.unresolved).toEqual([
      expect.objectContaining({ texts: expect.arrayContaining(['E']) }),
    ]);
  });

  it('flags several stall letters in one outline (a missing partition)', () => {
    const r = extractStalls(blockPlan({ texts: [text('F', 11, 5)] }));
    const d = r.stalls.find((s) => s.labels.texts.includes('F'))!;
    expect(d.issues.map((i) => i.code)).toContain('MULTIPLE_LABELS');
    expect(d.include).toBe(false);
  });

  it('calibrates every hall on its own grid origin', () => {
    // A second hall whose grid is offset by 0.3 m: its stall still lands on whole metres.
    const shifted = (x1: number, y1: number, x2: number, y2: number) =>
      seg(x1 + 50.3, y1 + 0.3, x2 + 50.3, y2 + 0.3);
    const r = extractStalls(
      blockPlan({
        paths: [
          grid(10, 10, 50.3, 0.3),
          partition(shifted(2, 2, 6, 2), shifted(6, 2, 6, 5), shifted(2, 2, 2, 5)),
          facia(
            ...[[6, 5, 2, 5]].flatMap(([a, b, c, d]) =>
              dashed(a + 50.3, b + 0.3, c + 50.3, d + 0.3),
            ),
          ),
        ],
        texts: [text('A', 53.3, 3.3), text('02-01', 57.3, 6.3)],
      }),
    );
    const a = r.stalls.find((s) => s.name === '02-01 A')!;
    expect(a.group).toBe('2');
    expect(a.area).toBe(12);
    expect(a.issues.map((i) => i.code)).not.toContain('OFF_GRID');
    expect(r.groups.map((g) => g.group).sort()).toEqual(['1', '2']);
  });

  it('falls back to line colours when the PDF has no layers, and says so', () => {
    const plan = blockPlan();
    for (const p of plan.paths) p.layer = '';
    const r = extractStalls(plan);
    expect(r.usedLayers).toBe(false);
    expect(r.stalls.find((s) => s.letter === 'C')?.shape).toBe('L-shape');
    expect(r.stalls.every((s) => s.confidence !== 'high')).toBe(true);
    expect(r.issues.join(' ')).toContain('no stall layers');
  });

  it('reads only the stall layers of a layered drawing, hatching as midpoints', () => {
    const modes = stallLayerModes([
      'GRID',
      'PARTITION',
      'FACIA',
      'Premium Stall',
      'MARQUE CO.',
      'MCP FIRE',
      '0',
    ])!;
    expect(['GRID', 'PARTITION', 'FACIA', 'Kiosk'].map(modes)).toEqual([
      'keep',
      'keep',
      'keep',
      'keep',
    ]);
    expect(['Premium Stall', 'MARQUE CO.'].map(modes)).toEqual(['midpoints', 'midpoints']);
    expect(['MCP FIRE', '0', 'TEXT'].map(modes)).toEqual(['skip', 'skip', 'skip']);
    // No stall layer: everything is read (colour fallback).
    expect(stallLayerModes(['0', 'TEXT'])).toBeNull();
  });

  it('classifies a stall from hatching read as midpoints', () => {
    const plan = blockPlan();
    // 300 hatch midpoints inside stall D (x 9..12, z 2..6): 25 per m².
    const xy: number[] = [];
    for (let i = 0; i < 300; i++)
      xy.push(pt(9.2 + (i % 20) * 0.13), pt(2.2 + Math.floor(i / 20) * 0.24));
    plan.marks = { 'Premium Stall': xy };
    const d = extractStalls(plan).stalls.find((s) => s.letter === 'D')!;
    expect(d.category).toBe('premium');
    expect(extractStalls(plan).stalls.find((s) => s.letter === 'C')!.category).toBe('standard');
  });

  it('refuses a drawing without a measurable grid', () => {
    const plan = blockPlan();
    plan.paths = plan.paths.filter((p) => p.layer !== 'GRID');
    expect(() => extractStalls(plan)).toThrow(/grid/);
  });
});
