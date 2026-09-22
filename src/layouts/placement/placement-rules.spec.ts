import {
  auditLayout,
  DEFAULT_LAYOUT_RULES,
  Footprint,
  formatStallNumber,
  PlacementContext,
  PlacementStall,
  Point,
  rectInsidePolygon,
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
});
