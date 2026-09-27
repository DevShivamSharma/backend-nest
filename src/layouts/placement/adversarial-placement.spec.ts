import { buildPlacementContext } from './hall-geometry';
import { auditLayout, validatePlacement, type PlacementStall, type Point } from './placement-rules';
import { overlaps, stallPolygon } from './polygon-geometry';

const hall = { shape: 'SQUARE', width: 40, length: 40 };
const stall = (extra: Partial<PlacementStall> = {}): PlacementStall => ({
  id: 'a',
  width: 2,
  length: 2,
  posX: 0,
  posZ: 0,
  openSides: ['FRONT'],
  ...extra,
});
// Independent transform: expected clearances come from axis-aligned fixtures, not production distance().
const transform = (p: Point, degrees: number): Point => {
  const radians = (degrees / 180) * Math.PI;
  return {
    x: 137 + p.x * Math.cos(radians) - p.z * Math.sin(radians),
    z: -83 + p.x * Math.sin(radians) + p.z * Math.cos(radians),
  };
};

describe('adversarial planner geometry', () => {
  it.each(Array.from({ length: 36 }, (_, i) => i * 10 + 0.37))(
    'ADV-G01 rigid transform %s degrees preserves exact/short corner gaps and touching backs',
    (rotation) => {
      for (const width of [3, 3.5, 5]) {
        for (const reversed of [false, true]) {
          const boundary = [
            { x: -20, z: -20 },
            { x: 20, z: -20 },
            { x: 20, z: 20 },
            { x: -20, z: 20 },
          ].map((p) => transform(p, rotation));
          if (reversed) boundary.reverse();
          const h = {
            ...hall,
            boundary,
            rules: { minPassageWidth: { B2B: width, B2C: width }, peripheralClearance: 0 },
          };
          const at = (x: number, z: number, extra: Partial<PlacementStall> = {}) => {
            const p = transform({ x, z }, rotation);
            return stall({ posX: p.x, posZ: p.z, rotation, ...extra });
          };
          const a = at(-19, -19);
          for (const short of [0, 0.001]) {
            const b = at(-17 + width - short, -19, { id: 'b' });
            const result = validatePlacement(a, buildPlacementContext(h, 'B2B', [b]), 'a');
            expect(result.valid).toBe(short === 0);
            if (short) expect(result.violations.map((v) => v.code)).toContain('CORNER_PASSAGE');
          }
          const backs = [at(0, -1, { openSides: ['BACK'] }), at(0, 1, { id: 'b' })];
          expect(auditLayout(buildPlacementContext(h, 'B2C', backs))).toEqual([]);
        }
      }
    },
  );

  it.each(['FRONT', 'BACK', 'LEFT', 'RIGHT'])(
    'ADV-G02 %s side rejects a 1 mm strip encroachment',
    (side) => {
      const direction = { FRONT: [0, 1], BACK: [0, -1], LEFT: [-1, 0], RIGHT: [1, 0] }[side]!;
      const a = stall({ openSides: [side] });
      const b = stall({ id: 'b', posX: direction[0] * 4.999, posZ: direction[1] * 4.999 });
      const result = validatePlacement(a, buildPlacementContext(hall, 'B2B', [b]), 'a');
      expect(result.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'OPEN_SIDE_BLOCKED', side })]),
      );
    },
  );

  it('ADV-G03 point contact is not a shared back; partial edge contact is allowed', () => {
    const a = stall({ openSides: ['BACK'] });
    for (const [posX, valid] of [
      [2, false],
      [1, true],
    ] as const) {
      const b = stall({ id: 'b', posX, posZ: 2 });
      expect(validatePlacement(a, buildPlacementContext(hall, 'B2B', [b]), 'a').valid).toBe(valid);
    }
  });

  it('ADV-G04 cancelled blockers are ignored but booked blockers are enforced', () => {
    for (const status of ['CANCELLED', 'BOOKED']) {
      const b = stall({ id: 'b', posZ: 3, status });
      expect(validatePlacement(stall(), buildPlacementContext(hall, 'B2B', [b]), 'a').valid).toBe(
        status === 'CANCELLED',
      );
    }
  });

  it('ADV-G05 audit reports BOTH facing open sides, with each affected stall', () => {
    const stalls = [stall(), stall({ id: 'b', posZ: 3, openSides: ['BACK'] })];
    const audit = auditLayout(buildPlacementContext(hall, 'B2B', stalls));
    for (const id of ['a', 'b']) {
      expect(audit.find((entry) => entry.stallId === id)?.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'OPEN_SIDE_BLOCKED' })]),
      );
    }
  });

  it('ADV-G06 overlap area is translation-invariant at large coordinates', () => {
    for (const offset of [0, 1e8, 1e9]) {
      expect(
        overlaps(
          stallPolygon(stall({ posX: offset, posZ: offset })),
          stallPolygon(stall({ posX: offset + 1.99, posZ: offset })),
        ),
      ).toBe(true);
    }
  });

  it('ADV-G07 finite coordinates which collapse stall edges are rejected without throwing', () => {
    const result = validatePlacement(
      stall({ posX: 1e20 }),
      buildPlacementContext({ ...hall, width: 1e22, length: 1e22 }, 'B2B', []),
      'a',
    );
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('INVALID_DIMENSIONS');
  });
});
