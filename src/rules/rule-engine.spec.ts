import { blankFloor, HallFloor } from '../venues/floor/hall-floor';
import { DEFAULT_RULE_VALUES, RuleId, RuleSwitches, valueProblems } from './rule-catalogue';
import { drawingProfile } from './drawing-profiles';
import { checkLayout, PlanStall, RuleOverride } from './rule-engine';
import type { FloorGeometry, MultiPolygon } from '../venues/floor-plan/plan.types';

/** A 40 x 30 m hall, with whatever areas a test adds. */
function hall(extra: Partial<HallFloor> = {}): HallFloor {
  return { ...blankFloor(40, 30), ...extra };
}

/** A 3 x 3 m stall at (x, y), open at the bottom. */
function stall(id: string, x: number, y: number, more: Partial<PlanStall> = {}): PlanStall {
  return { id, number: id, x, y, width: 3, depth: 3, openSides: ['bottom'], ...more };
}

/** Only the rules a test is about are on, so each test sees its own rule alone. */
function only(...ids: RuleId[]): RuleSwitches {
  const all: RuleId[] = [
    'hallBoundary',
    'stallOverlap',
    'sizeStep',
    'peripheralClearance',
    'openSideAccess',
    'PASSAGE',
    'NO_CONSTRUCTION',
    'ENTRY_EXIT_ACCESS',
    'EMERGENCY_EXIT_ACCESS',
    'FACILITY_ACCESS',
    'FOYER',
    'PARTITION',
    'SMOKE_CURTAIN',
    'cornerKeepOut',
    'internalZones',
    'eventSeparation',
    'maxUtilization',
  ];
  return Object.fromEntries(all.map((id) => [id, ids.includes(id)]));
}

function run(
  floor: HallFloor,
  stalls: PlanStall[],
  switches: RuleSwitches,
  overrides: RuleOverride[] = [],
) {
  return checkLayout({
    floor,
    stalls,
    switches,
    values: DEFAULT_RULE_VALUES,
    eventType: 'B2B',
    overrides,
  });
}

const ids = (r: ReturnType<typeof run>) => r.violations.map((v) => v.ruleId);

describe('rule engine', () => {
  it('passes a stall standing well inside an open hall', () => {
    const r = run(hall(), [stall('A1', 10, 10)], {});
    expect(r.violations).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('keeps stalls on the floor: not past the extent, not on outside, walls, voids or rooms', () => {
    const floor = hall({
      areas: [
        { kind: 'outside', x: 0, y: 0, width: 10, height: 30 },
        { kind: 'void', x: 20, y: 10, width: 4, height: 4 },
      ],
    });
    const r = run(
      floor,
      [stall('A', 8, 5), stall('B', 21, 11), stall('C', 38, 5), stall('D', 15, 5)],
      only('hallBoundary'),
    );
    expect(r.violations.map((v) => v.stallIds[0]).sort()).toEqual(['A', 'B', 'C']);
    expect(r.violations.find((v) => v.stallIds[0] === 'B')?.message).toMatch(/void/);
  });

  it('finds overlapping stalls, but lets stalls share a wall', () => {
    const r = run(
      hall(),
      [stall('A', 10, 10), stall('B', 12, 10), stall('C', 15, 10)],
      only('stallOverlap'),
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].stallIds).toEqual(['A', 'B']);
  });

  it('wants sizes in whole size steps', () => {
    const r = run(
      hall(),
      [stall('A', 10, 10, { width: 2.5 }), stall('B', 20, 10)],
      only('sizeStep'),
    );
    expect(r.violations.map((v) => v.stallIds[0])).toEqual(['A']);
  });

  it('keeps the wall clearance (ITPO D5) along outer walls and outside areas, not along columns', () => {
    const floor = hall({
      areas: [
        { kind: 'outside', x: 30, y: 0, width: 10, height: 30 },
        { kind: 'column', x: 15, y: 15, width: 1, height: 1 },
      ],
    });
    const r = run(
      floor,
      [stall('A', 0.5, 10), stall('B', 26.5, 10), stall('C', 16, 15), stall('D', 5, 10)],
      only('peripheralClearance'),
    );
    expect(r.violations.map((v) => v.stallIds[0]).sort()).toEqual(['A', 'B']);
    expect(r.violations[0].reference).toBe('ITPO D5');
  });

  it('keeps the passage width clear in front of open sides, from stalls and from the hall', () => {
    const r = run(
      hall(),
      [stall('A', 10, 10), stall('B', 10, 15), stall('C', 20, 25), stall('D', 30, 10)],
      only('openSideAccess'),
    );
    const blocked = r.violations.map((v) => v.stallIds[0]).sort();
    // A's front (3 m) reaches B at 15 m; C's front runs past the hall's far wall at 30 m.
    expect(blocked).toEqual(['A', 'C']);
    expect(r.violations.find((v) => v.stallIds[0] === 'A')?.stallIds).toContain('B');
  });

  it('keeps stalls off passages, no-construction zones and entries, and clear of curtains and services', () => {
    const floor = hall({
      areas: [
        { kind: 'passage', x: 0, y: 0, width: 40, height: 2 },
        { kind: 'no_build', x: 0, y: 28, width: 40, height: 2 },
        { kind: 'fire_curtain', x: 20, y: 0, width: 1, height: 30 },
        { kind: 'utility', x: 30, y: 15, width: 1, height: 1 },
      ],
    });
    const r = run(
      floor,
      [
        stall('A', 5, 1),
        stall('B', 5, 26),
        stall('C', 21.5, 10),
        stall('D', 31.5, 14),
        stall('E', 8, 10),
      ],
      only('PASSAGE', 'NO_CONSTRUCTION', 'SMOKE_CURTAIN', 'FACILITY_ACCESS'),
    );
    expect(ids(r).sort()).toEqual([
      'FACILITY_ACCESS',
      'NO_CONSTRUCTION',
      'PASSAGE',
      'SMOKE_CURTAIN',
    ]);
    expect(r.violations.find((v) => v.ruleId === 'SMOKE_CURTAIN')?.message).toMatch(
      /0\.5 m .* keep 1 m/,
    );
  });

  it('reports a band drawn in pieces once per stall', () => {
    const floor = hall({
      areas: [
        { kind: 'fire_curtain', x: 20, y: 0, width: 1, height: 15 },
        { kind: 'fire_curtain', x: 20, y: 15, width: 1, height: 15 },
      ],
    });
    const r = run(floor, [stall('A', 19, 14)], only('SMOKE_CURTAIN'));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toMatch(/stands on/);
  });

  it('keeps foyers free unless the rule set allows building there', () => {
    const floor = hall({
      zones: [{ kind: 'foyer', rects: [{ x: 0, y: 20, width: 40, height: 10 }] }],
    });
    expect(ids(run(floor, [stall('A', 10, 22)], only('FOYER')))).toEqual(['FOYER']);
    const allowed = checkLayout({
      floor,
      stalls: [stall('A', 10, 22)],
      switches: only('FOYER'),
      values: { ...DEFAULT_RULE_VALUES, foyerConstruction: true },
      eventType: 'B2B',
    });
    expect(allowed.violations).toEqual([]);
  });

  it('keeps the emergency exits marked on the plan free', () => {
    const floor = hall({
      iconGroups: [{ x: 20, y: 0, icons: [{ kind: 'emergency-exit', label: 'Exit' }] }],
    });
    expect(
      ids(run(floor, [stall('A', 19, 1), stall('B', 10, 10)], only('EMERGENCY_EXIT_ACCESS'))),
    ).toEqual(['EMERGENCY_EXIT_ACCESS']);
  });

  it('keeps a passage width from one wall at hall corners', () => {
    const r = run(
      hall(),
      [stall('A', 1, 1), stall('B', 1, 10), stall('C', 10, 1)],
      only('cornerKeepOut'),
    );
    expect(r.violations.map((v) => v.stallIds[0])).toEqual(['A']);
  });

  it('limits how much of the stall floor stalls cover', () => {
    const floor = blankFloor(10, 10);
    const stalls = [0, 3, 6].flatMap((x) => [0, 3, 6].map((y) => stall(`${x}-${y}`, x, y)));
    const r = run(floor, stalls, only('maxUtilization'));
    expect(ids(r)).toEqual(['maxUtilization']);
    expect(r.utilisation).toBeCloseTo(0.81, 2);
  });

  it('reports rules waiting for data as unavailable, and never checks them', () => {
    const r = run(hall(), [stall('A', 10, 10)], {});
    expect(r.rules.find((x) => x.id === 'internalZones')?.state).toBe('unavailable');
    expect(r.rules.find((x) => x.id === 'PARTITION')?.state).toBe('unavailable');
    expect(
      run(hall(), [stall('A', 10, 10)], { stallOverlap: false }).rules.find(
        (x) => x.id === 'stallOverlap',
      )?.state,
    ).toBe('off');
  });

  it('sets a violation aside with an override, keeping it listed with its reason', () => {
    const stalls = [stall('A', 10, 10), stall('B', 12, 10)];
    const r = run(hall(), stalls, only('stallOverlap'), [
      {
        ruleId: 'stallOverlap',
        stallIds: ['A', 'B'],
        reason: 'Joint stall of one exhibitor',
        by: 'Architect',
      },
    ]);
    expect(r.passed).toBe(true);
    expect(r.violations[0].overridden).toEqual({
      reason: 'Joint stall of one exhibitor',
      by: 'Architect',
    });
    expect(r.rules.find((x) => x.id === 'stallOverlap')).toMatchObject({
      violations: 0,
      overridden: 1,
    });
    // An override for other stalls does not cover these.
    const other = run(hall(), stalls, only('stallOverlap'), [
      { ruleId: 'stallOverlap', stallIds: ['A'], reason: 'x' },
    ]);
    expect(other.passed).toBe(false);
  });

  it('checks the 1 m grid drawing profile: whole metres, never turned', () => {
    const r = checkLayout({
      floor: hall(),
      stalls: [stall('A', 10.5, 10), stall('B', 20, 10, { rotation: 15 }), stall('C', 30, 10)],
      switches: only(),
      values: DEFAULT_RULE_VALUES,
      eventType: 'B2B',
      profile: drawingProfile('grid'),
    });
    expect(r.violations.map((v) => `${v.ruleId}:${v.stallIds[0]}`).sort()).toEqual([
      'profile.grid:A',
      'profile.rotation:B',
    ]);
  });

  it('refuses values outside their limits, and passages under 1.5 m', () => {
    expect(valueProblems(DEFAULT_RULE_VALUES)).toEqual([]);
    expect(valueProblems({ ...DEFAULT_RULE_VALUES, passageWidth: { B2B: 1, B2C: 3 } })).toEqual([
      'Passage width, B2B events must be 1.5–5 m.',
    ]);
  });

  describe('on a reviewed import (polygons)', () => {
    const ring = (pts: Array<[number, number]>): MultiPolygon => [[[...pts, pts[0]]]];
    // An L-shaped hall: 40 x 30, less its top-right 20 x 15, with a 4 x 4 lift void inside.
    const boundary: MultiPolygon = [
      [
        [
          [0, 0],
          [20, 0],
          [20, 15],
          [40, 15],
          [40, 30],
          [0, 30],
          [0, 0],
        ],
        [
          [8, 8],
          [12, 8],
          [12, 12],
          [8, 12],
          [8, 8],
        ],
      ],
    ];
    const geometry: FloorGeometry = {
      schema: 'geometry/1',
      unit: 'm',
      boundary,
      hallBoundary: boundary,
      grid: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      objects: [
        {
          id: 'nc',
          kind: 'no_build',
          label: 'NC',
          geometry: ring([
            [30, 20],
            [34, 20],
            [34, 22],
            [30, 22],
          ]),
          color: '#8b4513',
          blocksStalls: true,
          evidence: { source: 'legend', detail: 'NC' },
        },
      ],
      zones: [
        {
          id: 'f',
          name: 'Foyer',
          kind: 'foyer',
          geometry: ring([
            [0, 26],
            [10, 26],
            [10, 30],
            [0, 30],
          ]),
          shared: false,
          hallKeys: [],
        },
      ],
      source: { documentId: 'd', page: 1, regionId: 'r', origin: [0, 0], metresPerUnit: 1 },
      review: { revision: 1, checks: [], acknowledgements: [] },
    };
    const floor: HallFloor = { ...blankFloor(40, 30), geometry };

    it('reads the polygon floor: the cut-out corner and the hole are off the floor', () => {
      const r = run(
        floor,
        [stall('cut', 25, 5), stall('hole', 9, 9), stall('ok', 25, 20)],
        only('hallBoundary'),
      );
      expect(r.violations.map((v) => v.stallIds[0]).sort()).toEqual(['cut', 'hole']);
    });

    it('applies objects and foyers of the import, and measures walls along the outline', () => {
      const r = run(
        floor,
        [stall('nc', 31, 20), stall('foyer', 2, 26.5), stall('wall', 20.5, 15.5)],
        only('NO_CONSTRUCTION', 'FOYER', 'peripheralClearance'),
      );
      expect(r.violations.map((v) => `${v.ruleId}:${v.stallIds[0]}`).sort()).toEqual([
        'FOYER:foyer',
        'NO_CONSTRUCTION:nc',
        'peripheralClearance:foyer',
        'peripheralClearance:wall',
      ]);
    });

    it('finds the corners of the outline; the inner corner of the L traps no stall', () => {
      const r = run(
        floor,
        [stall('corner', 36.5, 15.5), stall('inner', 20.5, 15.5), stall('open', 25, 22)],
        only('cornerKeepOut'),
      );
      expect(r.violations.map((v) => v.stallIds[0])).toEqual(['corner']);
    });
  });
});
