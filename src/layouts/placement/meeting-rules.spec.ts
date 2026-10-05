import { atHallCorner } from './hall-corners';
import {
  DEFAULT_LAYOUT_RULES, effectiveRules, openingAccessRect, validatePlacement,
  type Footprint, type HallOpening, type PlacementContext,
} from './placement-rules';

const rectangle = (x: number, z: number, width: number, length: number) => [
  { x, z }, { x: x + width, z }, { x: x + width, z: z + length }, { x, z: z + length },
];
const candidate = (extra: Partial<Footprint> = {}): Footprint => ({
  posX: 0, posZ: 0, width: 2, length: 2, openSides: ['FRONT'], ...extra,
});
const context = (passage = 1.5): PlacementContext => ({
  boundary: rectangle(-20, -20, 40, 40), zones: [], openings: [], stalls: [],
  eventType: 'B2B', rules: { ...DEFAULT_LAYOUT_RULES, minPassageWidth: { B2B: passage, B2C: passage } },
});
const codes = (stall: Footprint, ctx: PlacementContext) =>
  validatePlacement(stall, ctx).violations.map(v => v.code);

for (const event of ['B2B', 'B2C'] as const) {
  test(`meeting rules: ${event} permits exactly 1.5 m and 5 m passages`, () => {
    for (const passage of [1.5, 5]) {
      const ctx = { ...context(passage), eventType: event };
      ctx.stalls = [{ ...candidate({ posZ: 2 + passage }), id: 'next' }];
      expect(validatePlacement(candidate(), ctx).valid).toBe(true);
      ctx.stalls[0].posZ -= 0.01;
      expect(codes(candidate(), ctx)).toContain('OPEN_SIDE_BLOCKED');
    }
    for (const passage of [1, 1.49, 5.01, NaN, Infinity]) {
      expect(codes(candidate(), { ...context(passage), eventType: event })).toContain('INVALID_PASSAGE_WIDTH');
    }
  });
}

test('meeting rules: emergency doors keep at least 3 m for every facing and narrower saved settings', () => {
  const ctx = context();
  const expected = {
    SOUTH: { minX: -1, maxX: 1, minZ: 0, maxZ: 3 },
    NORTH: { minX: -1, maxX: 1, minZ: -3, maxZ: 0 },
    EAST: { minX: 0, maxX: 3, minZ: -1, maxZ: 1 },
    WEST: { minX: -3, maxX: 0, minZ: -1, maxZ: 1 },
  };
  for (const facing of ['NORTH', 'SOUTH', 'EAST', 'WEST'] as const) {
    const door: HallOpening = { id: 'emergency', label: 'Emergency', kind: 'EMERGENCY',
      position: { x: 0, z: 0 }, width: 2, facing };
    for (const clearance of [undefined, 0, 1.5, 3]) {
      expect(openingAccessRect(door, { ...ctx.rules, openingAccessDepth: 1, emergencyExitClearance: clearance }, 'B2B')).toEqual(expected[facing]);
    }
  }
});

test('meeting rules: emergency restriction blocks stalls inside 3 m and permits the exact edge', () => {
  const ctx = context();
  const door: HallOpening = { id: 'door', label: 'Door', kind: 'EMERGENCY',
    position: { x: 0, z: -20 }, width: 4, facing: 'SOUTH' };
  ctx.openings = [door];
  expect(codes(candidate({ posZ: -17 }), ctx)).toContain('EMERGENCY_ACCESS');
  expect(validatePlacement(candidate({ posZ: -16 }), ctx).valid).toBe(true);
  ctx.openings = [{ ...door, kind: 'ENTRY' }];
  expect(validatePlacement(candidate({ posZ: -17 }), ctx).valid).toBe(true);
  expect(openingAccessRect(door, { ...ctx.rules, emergencyExitClearance: 4 }, 'B2B')?.maxZ).toBe(-16);
  expect(openingAccessRect(door, context(5).rules, 'B2B')?.maxZ).toBe(-15);
});

test('meeting rules: hall corners are on by default and can be switched off independently', () => {
  const ctx = context(3);
  const stall = candidate({ posX: -17, posZ: -17 });
  expect(codes(stall, ctx)).toContain('CORNER_PASSAGE');
  ctx.rules = { ...ctx.rules, enabledRules: { cornerKeepOut: false } };
  expect(validatePlacement(stall, ctx).valid).toBe(true);
  ctx.stalls = [{ ...stall, id: 'other' }];
  expect(codes(stall, ctx)).toContain('STALL_OVERLAP');
});

test('meeting rules: a full passage from either adjoining wall clears the corner', () => {
  const ctx = context(3);
  expect(atHallCorner(candidate({ posX: -17, posZ: -16 }), ctx)).toBe(false);
  expect(atHallCorner(candidate({ posX: -17, posZ: -16.01 }), ctx)).toBe(true);
  expect(atHallCorner(candidate({ posX: -16, posZ: -17 }), ctx)).toBe(false);
  expect(atHallCorner(candidate({ posX: -17, posZ: 0 }), ctx)).toBe(false);
});

test('meeting rules: corner distances follow rotated and custom footprints', () => {
  const ctx = context(3);
  const stall = candidate({ posX: -14, posZ: -14, width: 8, length: 2, rotation: 45 });
  expect(codes(stall, ctx)).toContain('CORNER_PASSAGE');
  expect(codes({ ...stall, footprint: rectangle(-4, -1, 8, 2), openEdges: [2] }, ctx)).toContain('CORNER_PASSAGE');
  expect(atHallCorner({ ...stall, posX: -13, posZ: -13 }, ctx)).toBe(false);
});

test('meeting rules: polygon notches and split or repeated wall vertices retain their corners', () => {
  const ctx = context(3);
  ctx.boundary = [{ x: -20, z: -20 }, { x: 20, z: -20 }, { x: 20, z: 0 },
    { x: 0, z: 0 }, { x: 0, z: 20 }, { x: -20, z: 20 }];
  expect(atHallCorner(candidate({ posX: -2, posZ: -2 }), ctx)).toBe(true);
  ctx.boundary = [{ x: -20, z: -20 }, { x: -19.5, z: -20 }, { x: 20, z: -20 },
    { x: 20, z: 20 }, { x: -20, z: 20 }, { x: -20, z: -19.5 }, { x: -20, z: -20 }];
  expect(atHallCorner(candidate({ posX: -17, posZ: -17 }), ctx)).toBe(true);
});

test('meeting rules: circles and interior obstacles do not create hall corners', () => {
  const ctx = context(3);
  ctx.circleRadius = 20;
  expect(atHallCorner(candidate({ posX: -17, posZ: -17 }), ctx)).toBe(false);
  delete ctx.circleRadius;
  ctx.obstacles = [rectangle(0, 0, 2, 2)];
  expect(atHallCorner(candidate({ posX: -2, posZ: -2 }), ctx)).toBe(false);
});

test('meeting rules: missing saved settings use the meeting defaults', () => {
  expect(effectiveRules({})).toMatchObject({ maxUtilization: 0.7, eventSeparation: 3,
    emergencyExitClearance: 3, minPassageWidth: { B2B: 3, B2C: 3 } });
});
