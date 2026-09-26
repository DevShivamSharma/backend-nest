import {
  auditLayout,
  DEFAULT_LAYOUT_RULES,
  extraFloorRegions,
  FloorArea,
  Footprint,
  formatStallNumber,
  PlacementContext,
  PlacementStall,
  Point,
  rectInsidePolygon,
  traceFloor,
  validatePlacement,
} from './placement-rules';

/*
 * The same cases run against the frontend copy
 * (frontend-angular/src/app/planner/geometry/placement-rules.spec.ts). Only matchers both Jest
 * and Jasmine support are used, so the file is identical in both places.
 *
 * Test hall: 40 x 20 m with a 10 x 8 m notch cut out of the top-right corner.
 *
 *   (0,0) ________________ (30,0)
 *        |                |
 *        |                |______ (40,8)
 *        |                       |
 *        |_______________________| (40,20)
 */
const HALL: Point[] = [
  { x: 0, z: 0 },
  { x: 30, z: 0 },
  { x: 30, z: 8 },
  { x: 40, z: 8 },
  { x: 40, z: 20 },
  { x: 0, z: 20 },
];

function ctx(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    boundary: HALL,
    zones: [],
    openings: [],
    rules: DEFAULT_LAYOUT_RULES,
    eventType: 'B2B',
    stalls: [],
    ...overrides,
  };
}

/** Footprint from its top-left corner, which is how the cases are easiest to read. */
function at(x: number, z: number, width: number, length: number): Footprint {
  return { posX: x + width / 2, posZ: z + length / 2, width, length };
}

function stall(id: string, x: number, z: number, width: number, length: number, extra: Partial<PlacementStall> = {}): PlacementStall {
  return { id, stallNumber: id, ...at(x, z, width, length), ...extra };
}

function codes(candidate: Footprint, context: PlacementContext, ignoreId: string | null = null): string[] {
  return validatePlacement(candidate, context, ignoreId).violations.map((v) => v.code);
}

describe('placement-rules', () => {
  describe('hall boundary', () => {
    it('accepts a stall well inside the irregular hall', () => {
      expect(validatePlacement(at(5, 5, 3, 2), ctx())).toEqual({ valid: true, violations: [] });
    });

    it('rejects a stall that reaches into the cut-out notch', () => {
      expect(codes(at(28, 3, 4, 2), ctx())).toContain('OUTSIDE_HALL');
    });

    it('rejects a stall entirely inside the notch', () => {
      expect(codes(at(33, 2, 3, 2), ctx())).toEqual(['OUTSIDE_HALL']);
    });

    it('treats touching the boundary as inside (the clearance rule is separate)', () => {
      expect(rectInsidePolygon({ minX: 0, minZ: 0, maxX: 3, maxZ: 2 }, HALL)).toBe(true);
    });
  });

  describe('peripheral clearance (ITPO D5)', () => {
    it('rejects a stall 0.5 m from the wall and reports what is left', () => {
      const result = validatePlacement(at(0.5, 5, 3, 2), ctx());
      expect(result.violations.map((v) => v.code)).toEqual(['PERIPHERAL_CLEARANCE']);
      expect(result.violations[0].message).toBe(
        '1 m peripheral clearance from the external wall is violated (0.5 m left).',
      );
      expect(result.violations[0].geometry[0]).toEqual({
        type: 'rect',
        rect: { minX: 0, maxX: 0.5, minZ: 5, maxZ: 7 },
      });
    });

    it('accepts exactly 1 m', () => {
      expect(codes(at(1, 5, 3, 2), ctx())).toEqual([]);
    });

    it('measures from the notch walls too', () => {
      expect(codes(at(26.5, 3, 3, 2), ctx())).toEqual(['PERIPHERAL_CLEARANCE']);
    });

    it('uses the configured value, not a grid cell', () => {
      const rules = { ...DEFAULT_LAYOUT_RULES, peripheralClearance: 2 };
      expect(codes(at(1, 5, 3, 2), ctx({ rules }))).toEqual(['PERIPHERAL_CLEARANCE']);
    });
  });

  describe('stall overlap', () => {
    const three = [stall('STALL-001', 5, 5, 3, 2), stall('STALL-002', 8, 5, 3, 2), stall('STALL-003', 11, 5, 3, 2)];

    it('rejects a large stall over three small ones and names them', () => {
      const result = validatePlacement(at(5, 5, 10, 10), ctx({ stalls: three }));
      expect(result.valid).toBe(false);
      expect(result.violations[0].code).toBe('STALL_OVERLAP');
      expect(result.violations[0].message).toBe(
        'Overlaps 3 existing stalls (STALL-001, STALL-002, STALL-003).',
      );
      expect(result.violations[0].geometry.length).toBe(3);
    });

    it('lets stalls touch edge to edge (back-to-back island)', () => {
      expect(codes(at(14, 5, 3, 2), ctx({ stalls: three }))).toEqual([]);
    });

    it('ignores the stall being moved', () => {
      expect(codes(at(5, 5, 3, 2), ctx({ stalls: three }), 'STALL-001')).toEqual([]);
    });

    it('ignores cancelled stalls: they no longer occupy space', () => {
      const cancelled = [stall('STALL-002', 8, 5, 3, 2, { status: 'CANCELLED' })];
      expect(codes(at(8, 5, 3, 2), ctx({ stalls: cancelled }))).toEqual([]);
    });
  });

  describe('passage width (ITPO D1)', () => {
    const existing = [stall('STALL-004', 5, 5, 3, 2)];

    it('rejects a 2 m gap for B2B (3 m required) and draws the gap', () => {
      const result = validatePlacement(at(10, 5, 3, 2), ctx({ stalls: existing }));
      expect(result.violations.map((v) => v.code)).toEqual(['PATHWAY_WIDTH']);
      expect(result.violations[0].message).toBe(
        'Required 3 m passage (B2B) is blocked: only 2 m left next to STALL-004.',
      );
      expect(result.violations[0].geometry[0]).toEqual({
        type: 'rect',
        rect: { minX: 8, maxX: 10, minZ: 5, maxZ: 7 },
      });
    });

    it('accepts a 3 m gap for B2B', () => {
      expect(codes(at(11, 5, 3, 2), ctx({ stalls: existing }))).toEqual([]);
    });

    it('rejects the same 3 m gap for B2C (4 m required)', () => {
      expect(codes(at(11, 5, 3, 2), ctx({ stalls: existing, eventType: 'B2C' }))).toEqual(['PATHWAY_WIDTH']);
    });

    it('measures diagonal gaps as a straight-line distance', () => {
      // 2 m right and 2 m down from STALL-004's corner: 2.83 m < 3 m.
      expect(codes(at(10, 9, 3, 2), ctx({ stalls: existing }))).toEqual(['PATHWAY_WIDTH']);
    });
  });

  describe('restricted zones', () => {
    const passage = {
      id: 'z1',
      kind: 'PASSAGE' as const,
      label: 'Compulsory passage',
      polygon: [
        { x: 18, z: 1 },
        { x: 20, z: 1 },
        { x: 20, z: 19 },
        { x: 18, z: 19 },
      ],
    };

    it('rejects overlapping a compulsory passage', () => {
      const result = validatePlacement(at(17, 5, 3, 2), ctx({ zones: [passage] }));
      expect(result.violations[0].code).toBe('RESTRICTED_ZONE');
      expect(result.violations[0].message).toBe(
        'Overlaps Compulsory passage (compulsory passage for entry/exit/services).',
      );
    });

    it('allows touching a zone with no clearance', () => {
      expect(codes(at(15, 5, 3, 2), ctx({ zones: [passage] }))).toEqual([]);
    });

    it('applies the configured clearance around a smoke curtain (ITPO D7)', () => {
      const curtain = { ...passage, kind: 'SMOKE_CURTAIN' as const, label: 'Smoke curtain' };
      const result = validatePlacement(at(15, 5, 2.5, 2), ctx({ zones: [curtain], rules: { ...DEFAULT_LAYOUT_RULES, snapStep: 0.5 } }));
      expect(result.violations.map((v) => v.message)).toEqual([
        'Keep 1 m free around Smoke curtain (0.5 m left).',
      ]);
    });
  });

  describe('openings (ITPO D2, D3)', () => {
    const exit = {
      id: 'o1',
      label: 'EE-1',
      kind: 'EMERGENCY' as const,
      position: { x: 20, z: 20 },
      width: 4,
      facing: 'NORTH' as const,
    };

    it('rejects a stall in front of an emergency exit', () => {
      expect(codes(at(19, 16, 3, 2), ctx({ openings: [exit] }))).toEqual(['EMERGENCY_ACCESS']);
    });

    it('sizes the access zone from the event passage width', () => {
      // Access zone is 3 m deep for B2B: z 17..20. A stall ending at z = 17 is clear.
      expect(codes(at(19, 14, 3, 3), ctx({ openings: [exit] }))).toEqual([]);
      expect(codes(at(19, 14, 3, 3), ctx({ openings: [exit], eventType: 'B2C' }))).toEqual(['EMERGENCY_ACCESS']);
    });
  });

  describe('dimensions', () => {
    it('rejects sizes that are not multiples of the snap step', () => {
      expect(codes(at(5, 5, 2.5, 2), ctx())).toEqual(['INVALID_DIMENSIONS']);
    });

    it('rejects non-positive sizes', () => {
      expect(codes(at(5, 5, 0, 2), ctx())).toEqual(['INVALID_DIMENSIONS']);
    });
  });

  describe('auditLayout', () => {
    it('reports a pair problem once, on the first stall of the pair', () => {
      const stalls = [stall('STALL-001', 5, 5, 3, 2), stall('STALL-002', 10, 5, 3, 2)];
      const entries = auditLayout(ctx({ stalls }));
      expect(entries.length).toBe(1);
      expect(entries[0].stallNumber).toBe('STALL-001');
      expect(entries[0].violations.map((v) => v.code)).toEqual(['PATHWAY_WIDTH']);
    });

    it('is empty for a valid layout', () => {
      const stalls = [stall('STALL-001', 5, 5, 3, 2), stall('STALL-002', 8, 5, 3, 2)];
      expect(auditLayout(ctx({ stalls }))).toEqual([]);
    });
  });

  it('formats stall numbers with a zero-padded sequence', () => {
    expect(formatStallNumber('STALL-', 7)).toBe('STALL-007');
    expect(formatStallNumber('STALL-', 1234)).toBe('STALL-1234');
  });

  /*
   * A Hall 1GF / 14GF-like plan on a 20 x 20 m canvas (top-left metres, converted below):
   *   main floor  x 2..18, z 2..10   (walls 1 m thick around it)
   *   outside strip z 11..12 across the whole width
   *   foyer       x 6..14, z 13..21  - its bottom wall reaches z 22, PAST the 20 m breadth
   */
  describe('traceFloor', () => {
    const W = 20;
    const L = 20;
    const rect = (x: number, y: number, w: number, h: number, kind: FloorArea['kind']): FloorArea => ({
      posX: x + w / 2 - W / 2,
      posZ: y + h / 2 - L / 2,
      width: w,
      length: h,
      kind,
    });
    const plan: FloorArea[] = [
      // main floor walls
      rect(1, 1, 18, 1, 'wall'),
      rect(1, 10, 18, 1, 'wall'),
      rect(1, 1, 1, 10, 'wall'),
      rect(18, 1, 1, 10, 'wall'),
      // everything around the main floor is outside
      rect(0, 0, 20, 1, 'outside'),
      rect(0, 0, 1, 11, 'outside'),
      rect(19, 0, 1, 11, 'outside'),
      rect(0, 11, 20, 1, 'outside'),
      // foyer walls, the bottom one below the canvas
      rect(5, 12, 10, 1, 'wall'),
      rect(5, 21, 10, 1, 'wall'),
      rect(5, 12, 1, 10, 'wall'),
      rect(14, 12, 1, 10, 'wall'),
      rect(0, 12, 5, 8, 'outside'),
      rect(15, 12, 5, 8, 'outside'),
      // a pillar inside the main floor
      rect(9, 5, 1, 1, 'zone'),
    ];
    const toPlan = (x: number, z: number): Point => ({ x: x - W / 2, z: z - L / 2 });

    it('keeps every disconnected floor region, largest first', () => {
      const floor = traceFloor(plan, W, L);
      expect(floor.length).toBe(2);
      expect(floor[0].area).toBeCloseTo(16 * 8, 6);
      expect(floor[1].area).toBeCloseTo(8 * 8, 6);
    });

    it('does not clip a walled region at the canvas breadth', () => {
      const foyer = traceFloor(plan, W, L)[1];
      const maxZ = Math.max(...foyer.outer.map((p) => p.z));
      expect(maxZ).toBeCloseTo(toPlan(0, 21).z, 6);
    });

    it('never turns the unmasked margin of the grown canvas into floor', () => {
      // The foyer walls grow the canvas to z = 22; the band z 20..22 beside them has no mask.
      const floor = traceFloor(plan, W, L);
      const total = floor.reduce((sum, r) => sum + r.area, 0);
      expect(total).toBeCloseTo(16 * 8 + 8 * 8, 6);
    });

    it('returns nothing for a plan without outside or wall rectangles', () => {
      expect(traceFloor([rect(2, 2, 1, 1, 'zone')], W, L)).toEqual([]);
    });

    it('lets a stall stand in the foyer when the boundary is only the main floor', () => {
      const floor = traceFloor(plan, W, L);
      const regions = extraFloorRegions(floor[0].outer, floor);
      expect(regions.length).toBe(1);

      const foyerStall = { posX: toPlan(10, 18).x, posZ: toPlan(10, 18).z, width: 2, length: 2 };
      const withoutFoyer = validatePlacement(foyerStall, ctx({ boundary: floor[0].outer, rules: { ...DEFAULT_LAYOUT_RULES, peripheralClearance: 0 } }));
      expect(withoutFoyer.violations.map((v) => v.code)).toContain('OUTSIDE_HALL');

      const withFoyer = validatePlacement(
        foyerStall,
        ctx({ boundary: floor[0].outer, regions, rules: { ...DEFAULT_LAYOUT_RULES, peripheralClearance: 0 } }),
      );
      expect(withFoyer.violations.map((v) => v.code)).not.toContain('OUTSIDE_HALL');
    });
  });
});
