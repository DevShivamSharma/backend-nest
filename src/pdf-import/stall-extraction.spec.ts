import type { PageVectors, VectorPath, VectorSegment } from './pdf-vectors';
import {
  extractStalls,
  fitOrigin,
  globalPitch,
  hallOfBlock,
  refineLattice,
  snapToHalfMetres,
  stallLayerModes,
} from './stall-extraction';

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

  it('reads floor-lettered block numbers such as 5G-26 and 5G-24AB (hall 5)', () => {
    const r = extractStalls(
      blockPlan({ texts: [] }),
    );
    expect(r.stalls.find((s) => s.letter === 'D')?.name).toBe('01-02 D');
    const lettered = extractStalls({
      ...blockPlan(),
      texts: blockPlan().texts.map((t) => (t.text === '01-02' ? { ...t, text: '5G-24AB' } : t)),
    });
    const d = lettered.stalls.find((s) => s.letter === 'D')!;
    expect([d.group, d.blockId, d.name]).toEqual(['5', '5G-24AB', '5G-24AB D']);
    expect(d.issues.map((i) => i.code)).not.toContain('NO_BLOCK');
  });

  it('tells a floor letter from a hall letter in block numbers', () => {
    expect(['11-05', '5G-26', '5G-24AB', '14GF-02', '12A-07', '1B-03', '12-01', 'IIFF-26'].map(hallOfBlock))
      .toEqual(['11', '5', '5', '14', '12A', '1B', '12', null]);
  });

  it('measures each axis on its own when a plot is scaled unevenly ("fit to paper")', () => {
    // x is plotted 0.6 % smaller than y. Corners at whole and half metres over a 100 m span.
    const px = 5.835, ox = 106.3;
    const values = Array.from({ length: 201 }, (_, i) => ox + (i / 2) * px);
    const fit = refineLattice(values, { pitch: 5.87, origin: 106, rms: 0, used: 0 });
    expect(fit.pitch).toBeCloseTo(px, 4);
    expect(fit.origin).toBeCloseTo(ox, 3);
    // Too few points or an implausible change keeps the coarse fit.
    const coarse = { pitch: 5.87, origin: 106, rms: 0, used: 0 };
    expect(refineLattice(values.slice(0, 5), coarse)).toBe(coarse);
  });

  it('snaps corners to half metres, and lets the area label settle a midway edge', () => {
    // A 4 x 4 stall read 3.986 wide: snaps cleanly.
    const plain = snapToHalfMetres(
      [{ x: 0.007, z: 0.007 }, { x: 3.993, z: 0.007 }, { x: 3.993, z: 3.993 }, { x: 0.007, z: 3.993 }],
      16,
    );
    expect(plain.points).toEqual([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }]);
    expect(plain.guided).toBe(false);
    // 8 x 11 = 88 m², the bottom edge read at 10.748: rounding alone gives 10.5 (84 m²).
    const midway = snapToHalfMetres(
      [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 10.748 }, { x: 0, z: 10.748 }],
      88,
    );
    expect(midway.points[2]).toEqual({ x: 8, z: 11 });
    expect(midway.guided).toBe(true);
    // Truly off the grid: kept as drawn.
    const off = snapToHalfMetres([{ x: 0.3, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }], null);
    expect(off.offGrid).toBe(true);
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

  it('reports the area its grid covers, in the group frame, for laying it on the hall', () => {
    const r = extractStalls(blockPlan());
    expect(r.gridAreas).toHaveLength(1);
    const [area] = r.gridAreas;
    const xs = area.outline.map((p) => p.x);
    const zs = area.outline.map((p) => p.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 1);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(20, 1);
    // The stalls lie on it, in the same frame.
    for (const st of r.stalls)
      for (const p of st.outline) {
        expect(p.x).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(p.z).toBeLessThanOrEqual(Math.max(...zs));
      }
  });

  it('refuses a drawing without a measurable grid', () => {
    const plan = blockPlan();
    plan.paths = plan.paths.filter((p) => p.layer !== 'GRID');
    expect(() => extractStalls(plan)).toThrow(/grid/);
  });
});
