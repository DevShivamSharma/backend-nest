import { buildPlacementContext } from './hall-geometry';
import { validatePlacement, type PlacementStall, type Point } from './placement-rules';
import { stallPolygon } from './polygon-geometry';
import { normalizeFootprint, normalizeOpenEdges, polygonArea, sidesOfEdges } from './stall-footprint';

/*
 * The L-shaped stall "H" of block 11-13/11-14 in the IITF 2026 Hall 8-11 plan: a 7 x 3 m arm
 * along the top and a 3 x 3 m arm hanging down on the right, 30 m² in all, the notch (4 x 3 m,
 * bottom-left) not part of it. Local metres, X right, Z down.
 */
const L: Point[] = [
  { x: 0, z: 0 },
  { x: 7, z: 0 },
  { x: 7, z: 6 },
  { x: 4, z: 6 },
  { x: 4, z: 3 },
  { x: 0, z: 3 },
];

describe('normalizeFootprint', () => {
  it('keeps an L-shape as one six-corner outline centred on its bounding box', () => {
    const n = normalizeFootprint(L);
    if (typeof n === 'string') throw new Error(n);
    expect(n.points.length).toBe(6);
    expect(n.width).toBe(7);
    expect(n.length).toBe(6);
    expect(polygonArea(n.points)).toBeCloseTo(30, 9);
    expect(n.offset).toEqual({ x: 3.5, z: 3 });
    expect(n.points[0]).toEqual({ x: -3.5, z: -3 });
  });

  it('turns a counter-clockwise outline clockwise and renumbers its edges', () => {
    const ccw = [...L].reverse();
    const n = normalizeFootprint(ccw);
    if (typeof n === 'string') throw new Error(n);
    // ccw edge 0 runs (0,3) -> (4,3): the same segment as clockwise edge 4 (4,3) -> (0,3).
    const canonical = n.edgeMap.get(0)!;
    const a = n.points[canonical];
    const b = n.points[(canonical + 1) % n.points.length];
    const seg = [a, b].map((p) => ({ x: p.x + 3.5, z: p.z + 3 }));
    expect(seg).toEqual([
      { x: 4, z: 3 },
      { x: 0, z: 3 },
    ]);
  });

  it('drops collinear and repeated points', () => {
    const n = normalizeFootprint([
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 3, z: 0 },
      { x: 6, z: 0 },
      { x: 6, z: 4 },
      { x: 0, z: 4 },
      { x: 0, z: 0 },
    ]);
    if (typeof n === 'string') throw new Error(n);
    expect(n.points.length).toBe(4);
  });

  it.each([
    [[{ x: 0, z: 0 }, { x: 1, z: 0 }], 'at least 3'],
    [[{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 2, z: 0 }, { x: 0, z: 2 }], 'cross'],
    [[{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], 'at least 3'],
    [[{ x: 0, z: 'a' }, { x: 1, z: 0 }, { x: 1, z: 1 }], 'finite'],
    ['nope', 'list'],
  ])('rejects %j', (raw, message) => {
    expect(normalizeFootprint(raw)).toEqual(expect.stringContaining(message));
  });

  it('validates open edges against the outline', () => {
    expect(normalizeOpenEdges([3, 3, 0], 6)).toEqual([0, 3]);
    expect(normalizeOpenEdges([6], 6)).toEqual(expect.stringContaining('0 to 5'));
    expect(sidesOfEdges(L, [3, 4])).toEqual(['LEFT', 'FRONT']);
  });
});

describe('L-shaped stall placement', () => {
  const hall = { shape: 'SQUARE', width: 40, length: 40, rules: { peripheralClearance: 0 } };
  const n = normalizeFootprint(L);
  if (typeof n === 'string') throw new Error(n);
  const lStall: PlacementStall = {
    id: 'L',
    posX: 0,
    posZ: 0,
    width: n.width,
    length: n.length,
    footprint: n.points,
    // Open along the notch: edges (4,6)->(4,3) and (4,3)->(0,3).
    openEdges: [3, 4],
  };
  const box = (id: string, posX: number, posZ: number, w = 2, l = 2): PlacementStall => ({
    id,
    posX,
    posZ,
    width: w,
    length: l,
    openSides: ['FRONT'],
  });
  const check = (a: PlacementStall, others: PlacementStall[]) =>
    validatePlacement(a, buildPlacementContext(hall, 'B2B', [a, ...others]), a.id);

  it('uses the real outline: the notch is empty, not part of the stall', () => {
    const p = stallPolygon(lStall);
    expect(p.length).toBe(6);
    expect(polygonArea(p)).toBeCloseTo(30, 9);
  });

  it('rejects a stall overlapping an arm and accepts one wholly in the notch area', () => {
    // Arm: local (5.5, 1.5) -> centred (2, -1.5).
    const onArm = check(box('x', 2, -1.5, 1, 1), [lStall]);
    expect(onArm.violations.map((v) => v.code)).toContain('STALL_OVERLAP');
    // Notch: local x 0..4, z 3..6 -> centred x -3.5..0.5, z 0..3. A 1 x 1 m box there does
    // not overlap the L (it only sits in front of its open edges, which is a passage rule).
    const inNotch = check(box('y', -1.5, 2, 1, 1), [lStall]);
    expect(inNotch.violations.map((v) => v.code)).not.toContain('STALL_OVERLAP');
  });

  it('keeps the L one polygon after rotating it by 90 degrees', () => {
    const turned = stallPolygon({ ...lStall, rotation: 90 });
    expect(turned.length).toBe(6);
    expect(polygonArea(turned)).toBeCloseTo(30, 9);
  });

  it('requires passage in front of every open edge of the outline', () => {
    const inNotch = check(box('y', -1.5, 2, 1, 1), [lStall]);
    // The box stands in front of the notch edges: it blocks the L's open frontage.
    const blockers = check(lStall, [box('y', -1.5, 2, 1, 1)]);
    expect([...inNotch.violations, ...blockers.violations].map((v) => v.code)).toEqual(
      expect.arrayContaining(['PATHWAY_WIDTH']),
    );
    const clear = check(lStall, []);
    expect(clear.valid).toBe(true);
  });
});
