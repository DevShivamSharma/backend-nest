import { BASIC_RULE_IDS, BasicRuleId, BasicRuleSettings } from './basic-rules';
import { DEFAULT_LAYOUT_RULES, Footprint, PlacementContext, validatePlacement, ZONE_KINDS } from './placement-rules';
import { validateHallGeometry } from './hall-geometry';
import { assertPlacements } from './assert-placements';

const rect = (x: number, z: number, w: number, l: number) => [
  { x, z }, { x: x + w, z }, { x: x + w, z: z + l }, { x, z: z + l }
];
const candidate: Footprint = { posX: 0, posZ: 0, width: 2, length: 2, openSides: ['FRONT'] };
const context = (enabledRules: BasicRuleSettings = {}, extra: Partial<PlacementContext> = {}): PlacementContext => ({
  boundary: rect(-10, -10, 20, 20), zones: [], openings: [], stalls: [], eventType: 'B2B',
  rules: { ...DEFAULT_LAYOUT_RULES, enabledRules }, enforceGrid: true, ...extra
});
const codes = (f: Footprint, c: PlacementContext) => validatePlacement(f, c).violations.map(v => v.code);

test('every basic check can be disabled independently for rectangular and rotated stalls', () => {
  for (const rotation of [0, 90]) {
    const f = { ...candidate, rotation };
    const cases: Array<[BasicRuleId, Footprint, Partial<PlacementContext>, string]> = [
      ['hallBoundary', { ...f, posX: 15 }, {}, 'OUTSIDE_HALL'],
      ['peripheralClearance', { ...f, posX: 8.5 }, {}, 'PERIPHERAL_CLEARANCE'],
      ['stallOverlap', f, { stalls: [{ ...f, id: 'other' }] }, 'STALL_OVERLAP'],
      ['sizeStep', { ...f, width: 2.3 }, {}, 'INVALID_DIMENSIONS'],
      ['openSideAccess', f, { stalls: [{ ...f, id: 'other', posZ: rotation ? 0 : 3, posX: rotation ? -3 : 0 }] }, 'OPEN_SIDE_BLOCKED']
    ];
    for (const [rule, stall, extra, code] of cases) {
      expect(codes(stall, context({}, extra))).toContain(code);
      expect(codes(stall, context({ [rule]: false }, extra))).not.toContain(code);
    }
    for (const kind of ZONE_KINDS) {
      const extra = { zones: [{ id: kind, kind, label: kind, polygon: rect(-2, -2, 4, 4) }] };
      expect(codes(f, context({}, extra))).toContain('RESTRICTED_ZONE');
      expect(codes(f, context({ [kind]: false }, extra))).not.toContain('RESTRICTED_ZONE');
    }
    for (const kind of ['ENTRY', 'EMERGENCY'] as const) {
      const extra = { openings: [{ id: kind, kind, label: kind, position: { x: 0, z: -2 }, width: 4, facing: 'SOUTH' as const }] };
      const code = kind === 'EMERGENCY' ? 'EMERGENCY_ACCESS' : 'ENTRY_EXIT_BLOCKED';
      const key = kind === 'EMERGENCY' ? 'EMERGENCY_EXIT_ACCESS' : 'ENTRY_EXIT_ACCESS';
      expect(codes(f, context({}, extra))).toContain(code);
      expect(codes(f, context({ [key]: false }, extra))).not.toContain(code);
    }
  }
});

test('disabled checks survive validation and are respected by save validation; invalid values are rejected', () => {
  const enabledRules = Object.fromEntries(BASIC_RULE_IDS.map(id => [id, false]));
  const validated = validateHallGeometry({ rules: { enabledRules } });
  expect(validated.rules?.enabledRules).toEqual(enabledRules);
  const hall = { shape: 'SQUARE', width: 20, length: 20, rules: validated.rules };
  expect(() => assertPlacements(hall, 'B2B', [{ ...candidate, posX: 15 }])).not.toThrow();
  expect(() => assertPlacements({ ...hall, rules: {} }, 'B2B', [{ ...candidate, posX: 15 }])).toThrow();
  for (const enabledRules of [null, [], { unknown: false }, { hallBoundary: 'false' }, { sizeStep: null }]) {
    expect(() => validateHallGeometry({ rules: { enabledRules } })).toThrow();
  }
  expect(codes({ ...candidate, width: -2 }, context(enabledRules))).toContain('INVALID_DIMENSIONS');
  expect(codes({ ...candidate, width: 2.3 }, context({ peripheralClearance: false }))).toContain('INVALID_DIMENSIONS');
});
