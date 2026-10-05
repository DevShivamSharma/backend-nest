import { buildPlacementContext, validateHallGeometry } from './hall-geometry';
import { validatePlacement, type PlacementStall, type Point } from './placement-rules';
import { rotate, stallPolygon, contained, ring } from './polygon-geometry';
import { splitSuffix } from '../split-numbering';

const hall = { shape: 'SQUARE', width: 40, length: 40 };
const stall = (extra: Partial<PlacementStall> = {}): PlacementStall => ({
  id: 'a',
  posX: 0,
  posZ: 0,
  width: 2,
  length: 2,
  openSides: ['FRONT'],
  ...extra,
});
function check(
  a: PlacementStall,
  others: PlacementStall[] = [],
  h: Parameters<typeof buildPlacementContext>[0] = hall,
) {
  return validatePlacement(a, buildPlacementContext(h, 'B2B', others), a.id);
}
const codes = (r: ReturnType<typeof check>) => r.violations.map((v) => v.code);

describe('authoritative rotated passage validation', () => {
  it.each([1.5, 3, 5])('closed sides need no %s metre gap when corner keep-out is off', (width) => {
    const h = {
      ...hall,
      rules: { minPassageWidth: { B2B: width, B2C: width }, peripheralClearance: 0, enabledRules: { cornerKeepOut: false } },
    };
    const a = stall({ posX: -19, posZ: -19 });
    const b = stall({ id: 'b', posX: -17 + width, posZ: -19 });
    expect(check(a, [b], h).valid).toBe(true);
    expect(check(a, [{ ...b, posX: b.posX - 0.01 }], h).valid).toBe(true);
    // A shared wall.
    expect(check(a, [{ ...b, posX: -17 }], h).valid).toBe(true);
  });
  it.each([1.49, 5.01, -1, 0, NaN, Infinity, '3', null])('rejects invalid width %p', (width) => {
    expect(() => validateHallGeometry({ rules: { minPassageWidth: { B2B: width } } })).toThrow(
      'between 1.5 and 5',
    );
  });
  it('defaults both event types to 3 and persists explicit fractional widths', () => {
    expect(buildPlacementContext(hall, 'B2C', []).rules.minPassageWidth).toEqual({
      B2B: 3,
      B2C: 3,
    });
    expect(
      validateHallGeometry({ rules: { minPassageWidth: { B2B: 3.5, B2C: 5 } } }).rules
        ?.minPassageWidth,
    ).toEqual({ B2B: 3.5, B2C: 5 });
    expect(validateHallGeometry({ rules: { minPassageWidth: { B2B: 1.5 } } }).rules?.minPassageWidth)
      .toEqual({ B2B: 1.5, B2C: 3 });
  });
  it('preserves meeting settings and rejects invalid numeric settings', () => {
    const rules = { maxUtilization: 0.7, eventSeparation: 3, emergencyExitClearance: 3,
      enabledRules: { cornerKeepOut: false } };
    expect(validateHallGeometry({ rules }).rules).toEqual(rules);
    for (const value of [0, -1, 1.01, NaN, Infinity, '0.7']) {
      expect(() => validateHallGeometry({ rules: { maxUtilization: value } })).toThrow();
    }
    for (const value of [-1, NaN, Infinity, '3']) {
      expect(() => validateHallGeometry({ rules: { eventSeparation: value } })).toThrow();
    }
    for (const value of [0, 1.5, 2.99, NaN, Infinity, '3']) {
      expect(() => validateHallGeometry({ rules: { emergencyExitClearance: value } })).toThrow();
    }
  });
  it('accepts touching backs with opposite outward open sides', () => {
    const a = stall({ posZ: -1, openSides: ['BACK'] });
    const b = stall({ id: 'b', posZ: 1 });
    expect(check(a, [b]).valid).toBe(true);
    expect(check(b, [a]).valid).toBe(true);
  });
  it('rejects touching on an open side', () => {
    const a = stall({ posZ: -1, openSides: ['FRONT'] });
    expect(codes(check(a, [stall({ id: 'b', posZ: 1 })]))).toContain('OPEN_SIDE_BLOCKED');
  });
  it.each([[['LEFT']], [['BACK', 'RIGHT']]])(
    'accepts a shared wall on a closed side with open sides %p',
    (sides) => {
      const a = stall({ posZ: -1, openSides: sides });
      expect(check(a, [stall({ id: 'b', posZ: 1 })]).valid).toBe(true);
    },
  );
  it('lets corner stalls share a closed wall when corner keep-out is off', () => {
    const a = stall({ posX: -19, posZ: -19, openSides: ['RIGHT'] });
    const b = stall({ id: 'b', posX: -19, posZ: -17, openSides: ['FRONT'] });
    expect(check(a, [b], { ...hall, rules: { peripheralClearance: 0, enabledRules: { cornerKeepOut: false } } }).valid).toBe(true);
  });
  it.each([1.5, 3, 5])('open side must have exactly %s metres inside the hall', (width) => {
    const h = {
      ...hall,
      rules: { minPassageWidth: { B2B: width, B2C: width }, peripheralClearance: 0 },
    };
    expect(check(stall({ posZ: 19 - width }), [], h).valid).toBe(true);
    expect(codes(check(stall({ posZ: 19 - width + 0.001 }), [], h))).toContain('OPEN_SIDE_PASSAGE');
  });
  it('another stall cannot enter any open-side strip', () => {
    expect(
      codes(check(stall({ openSides: ['FRONT', 'RIGHT'] }), [stall({ id: 'b', posX: 4 })])),
    ).toContain('OPEN_SIDE_BLOCKED');
  });
  it.each([30, 45, 90, 135, 270])(
    'rotates edges AND sides by %s degrees, preserving valid backs and open-side passage',
    (rotation) => {
      const centre = rotate({ x: 0, z: 2 }, rotation);
      const a = stall({ rotation, openSides: ['BACK'] });
      const b = stall({ id: 'b', rotation, posX: centre.x, posZ: centre.z });
      expect(check(a, [b]).valid).toBe(true);
      // Beside a closed side any gap is fine.
      const beside = rotate({ x: 4.99, z: 0 }, rotation);
      expect(check(a, [{ ...b, posX: beside.x, posZ: beside.z }]).valid).toBe(true);
      // In front of the open side the whole passage stays clear.
      const far = rotate({ x: 0, z: -5 }, rotation);
      expect(check(a, [{ ...b, openSides: ['BACK'], posX: far.x, posZ: far.z }]).valid).toBe(true);
      const near = rotate({ x: 0, z: -4.99 }, rotation);
      expect(
        codes(check(a, [{ ...b, openSides: ['BACK'], posX: near.x, posZ: near.z }])),
      ).toContain('OPEN_SIDE_BLOCKED');
    },
  );
  it('detects a rotated footprint outside the hall even if unrotated extents fit', () => {
    expect(codes(check(stall({ width: 4, length: 4, posX: 18, rotation: 45 })))).toContain(
      'OUTSIDE_HALL',
    );
  });
  const irregular: Point[] = [
    { x: -20, z: -20 },
    { x: 20, z: -20 },
    { x: 20, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 20 },
    { x: -20, z: 20 },
  ];
  it('outside space in a concave notch is never passage', () => {
    expect(
      codes(check(stall({ posX: 5, posZ: -2 }), [], { ...hall, boundary: irregular })),
    ).toContain('OPEN_SIDE_PASSAGE');
  });
  it('accepts touching backs next to a notch corner with corner keep-out off', () => {
    const a = stall({ posX: -2, posZ: -2, openSides: ['BACK'] });
    const b = stall({ id: 'b', posX: -2, posZ: 0 });
    expect(check(a, [b], { ...hall, boundary: irregular, rules: { peripheralClearance: 0, enabledRules: { cornerKeepOut: false } } }).valid).toBe(true);
  });
  it('needs no passage between closed sides either side of an exterior notch', () => {
    const boundary = [
      { x: -20, z: -20 },
      { x: -2, z: -20 },
      { x: -2, z: 5 },
      { x: 2, z: 5 },
      { x: 2, z: -20 },
      { x: 20, z: -20 },
      { x: 20, z: 20 },
      { x: -20, z: 20 },
    ];
    const a = stall({ posX: -3, posZ: -19 });
    const b = stall({ id: 'b', posX: 3, posZ: -19 });
    expect(check(a, [b], { ...hall, boundary, rules: { peripheralClearance: 0, enabledRules: { cornerKeepOut: false } } }).valid).toBe(true);
  });
  it('detects an edge crossing a narrow concavity even when all vertices are inside', () => {
    const boundary = [
      { x: -10, z: -10 },
      { x: -0.1, z: -10 },
      { x: -0.1, z: 1 },
      { x: 0.1, z: 1 },
      { x: 0.1, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ];
    expect(codes(check(stall({ width: 4, length: 4 }), [], { ...hall, boundary }))).toContain(
      'OUTSIDE_HALL',
    );
  });
  it('subtracts blocked-area holes from usable floor and passage', () => {
    const blockedAreas = [
      { posX: 0, posZ: 3, width: 0.1, length: 0.1, kind: 'outside' as const, color: '#fff' },
    ];
    expect(codes(check(stall(), [], { ...hall, blockedAreas }))).toContain('OPEN_SIDE_PASSAGE');
    expect(codes(check(stall({ posZ: 3 }), [], { ...hall, blockedAreas }))).toContain(
      'OUTSIDE_HALL',
    );
  });
  it('uses true circular boundary for open-side passage', () => {
    expect(
      codes(check(stall({ posX: 7, posZ: 3 }), [], { shape: 'CIRCLE', radius: 10 })),
    ).toContain('OPEN_SIDE_PASSAGE');
  });
  it('rejects malformed boundaries rather than treating them as usable floor', () => {
    expect(() =>
      validateHallGeometry({
        boundary: [
          { x: 0, z: 0 },
          { x: 4, z: 4 },
          { x: 0, z: 4 },
          { x: 4, z: 0 },
        ],
      }),
    ).toThrow('simple polygon');
  });
  it('checks split containment against rotated parent geometry', () => {
    expect(
      contained(stallPolygon(stall({ width: 3, length: 3 })), [
        ring(stallPolygon(stall({ width: 4, length: 4, rotation: 45 }))),
      ]),
    ).toBe(false);
  });
});

describe('split identifiers', () => {
  it('issues A through Z, then AA, AB, AZ, BA, ZZ, AAA', () => {
    expect(Array.from({ length: 26 }, (_, i) => splitSuffix(i)).join('')).toBe(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    );
    expect([26, 27, 51, 52, 701, 702].map(splitSuffix)).toEqual([
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
    expect(`5-10-${splitSuffix(0)}`).toBe('5-10-A');
  });
});
