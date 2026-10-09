import { DEFAULT_RULE_VALUES, RULE_IDS, RuleId, RuleSwitches } from '../rules/rule-catalogue';
import type { PlanStall } from '../rules/rule-engine';
import { blankFloor, HallFloor } from '../venues/floor/hall-floor';
import { checkPlan, findingsFor, PlanSeatRect, PlanZoneShape } from './plan-check';

/** A 40 x 30 m hall, with whatever areas a test adds. */
function hall(extra: Partial<HallFloor> = {}): HallFloor {
  return { ...blankFloor(40, 30), ...extra };
}

function only(...ids: RuleId[]): RuleSwitches {
  return Object.fromEntries(RULE_IDS.map((id) => [id, ids.includes(id)]));
}

function seat(id: string, x: number, y: number): PlanSeatRect {
  return { id, label: id, x, y, width: 0.5, depth: 0.5 };
}

function stall(id: string, x: number, y: number, more: Partial<PlanStall> = {}): PlanStall {
  return { id, number: id, x, y, width: 3, depth: 3, openSides: ['bottom'], ...more };
}

function run(
  floor: HallFloor,
  switches: RuleSwitches,
  parts: { stalls?: PlanStall[]; seats?: PlanSeatRect[]; zones?: PlanZoneShape[] },
) {
  return checkPlan({
    floor,
    switches,
    values: DEFAULT_RULE_VALUES,
    eventType: 'B2B',
    profile: null,
    stalls: parts.stalls ?? [],
    seats: parts.seats ?? [],
    zones: parts.zones ?? [],
  });
}

describe('plan check', () => {
  it('passes seats standing on open floor', () => {
    const seats = [seat('A-1', 10, 10), seat('A-2', 10.6, 10)];
    expect(run(hall(), only('hallBoundary', 'stallOverlap'), { seats })).toEqual([]);
  });

  it('refuses a seat off the floor and a seat on a pillar', () => {
    const floor = hall({
      areas: [{ kind: 'column', x: 20, y: 20, width: 1, height: 1, label: 'Pillar' }],
    });
    const found = run(floor, only('hallBoundary'), {
      seats: [seat('A-1', 39.8, 5), seat('A-2', 20.2, 20.2)],
    });
    expect(found.map((f) => f.ids)).toEqual([['A-1'], ['A-2']]);
    expect(found[1].message).toContain('pillar');
  });

  it('refuses seats overlapping a stall or each other', () => {
    const found = run(hall(), only('stallOverlap'), {
      stalls: [stall('S1', 5, 5)],
      seats: [seat('A-1', 6, 6), seat('B-1', 15, 15), seat('B-2', 15.2, 15)],
    });
    expect(found.map((f) => f.ids)).toEqual([
      ['A-1', 'S1'],
      ['B-1', 'B-2'],
    ]);
  });

  it('refuses seats in front of an open side of a stall', () => {
    const found = run(hall(), only('openSideAccess'), {
      stalls: [stall('S1', 5, 5)],
      seats: [seat('A-1', 6, 8.5)],
    });
    expect(found).toHaveLength(1);
    expect(found[0].ids).toEqual(['S1', 'A-1']);
  });

  it('refuses a zone reaching past the hall', () => {
    const zones: PlanZoneShape[] = [
      {
        id: 'Z',
        name: 'Food court',
        polygon: [
          [35, 0],
          [45, 0],
          [45, 10],
          [35, 10],
        ],
      },
    ];
    expect(run(hall(), only('hallBoundary'), { zones })[0].message).toContain('Food court');
  });

  it('keeps only findings about what changed, or about the whole plan', () => {
    const findings = [
      { ruleId: 'a', message: '', ids: ['x'] },
      { ruleId: 'b', message: '', ids: ['y', 'z'] },
      { ruleId: 'c', message: '', ids: [] },
    ];
    expect(findingsFor(findings, new Set(['z'])).map((f) => f.ruleId)).toEqual(['b', 'c']);
  });
});
