import { forHall, hallFloor, hallNumbers, WrongPlanError } from './hall-match';
import type { ExtractionResult, ExtractedStall, GroupCalibration } from './stall-extraction';

/** A drawing of several halls, each stall a 10 pt square at (x, y) on the page. */
function drawing(
  stalls: Array<[group: string, name: string, x: number, y: number]>,
): ExtractionResult {
  const groups = [...new Set(stalls.map((s) => s[0]))].map(
    (group) => ({ group, pitchX: 10, pitchY: 10, originX: 0, originY: 0 }) as GroupCalibration,
  );
  return {
    page: { width: 1000, height: 1000, rotation: 0 },
    layers: [],
    usedLayers: true,
    groups,
    stalls: stalls.map(
      ([group, name, x, y]) =>
        ({
          key: name,
          group,
          name,
          blockId: name.split(' ')[0],
          letter: name.split(' ')[1] ?? null,
          issues: [],
          outline: [
            { x: x / 10, z: y / 10 },
            { x: x / 10 + 1, z: y / 10 },
            { x: x / 10 + 1, z: y / 10 + 1 },
            { x: x / 10, z: y / 10 + 1 },
          ],
          outlinePt: [
            { x, z: y },
            { x: x + 10, z: y },
            { x: x + 10, z: y + 10 },
            { x, z: y + 10 },
          ],
        }) as unknown as ExtractedStall,
    ),
    excluded: [],
    unresolved: [
      { texts: ['08-02 A'], x: 105, y: 105, reason: 'no outline' },
      { texts: ['10-01 A'], x: 805, y: 805, reason: 'no outline' },
    ],
    gridAreas: groups.map((g) => ({ group: g.group, outline: [], area: 100 })),
    floor: null,
    issues: [],
  };
}

const plan = drawing([
  ['8', '08-01 A', 100, 100],
  ['8', '08-01 B', 110, 100],
  ['9', '09-01 A', 400, 400],
  ['10', '10-01 A', 800, 800],
]);

describe('the stalls of the hall being planned', () => {
  it('reads hall numbers from a name or code, the floor letter left off', () => {
    expect([...hallNumbers(['Hall 8-9-10', null])]).toEqual(['8', '9', '10']);
    expect([...hallNumbers(['Hall 5G', 'H5'])]).toEqual(['5']);
    expect([...hallNumbers(['Hall 12A'])]).toEqual(['12A']);
    expect([...hallNumbers(['Hall 14GF'])]).toEqual(['14']);
    expect([...hallNumbers(['Hall 14FF'])]).toEqual(['14']);
  });

  it('reads the floor from a name or code', () => {
    expect(hallFloor(['Hall 14GF', null])).toBe('GF');
    expect(hallFloor(['Hall 14FF', null])).toBe('FF');
    expect(hallFloor(['Main hall', 'H5G'])).toBe('GF');
    expect(hallFloor(['Hall 4 First Floor', null])).toBe('FF');
    expect(hallFloor(['Hall 12A', null])).toBeNull();
  });

  it('refuses the plan of the other floor of the same hall', () => {
    const groundFloor = { ...drawing([['14', '14-01 A', 100, 100]]), floor: 'GF' as const };
    expect(() => forHall(groundFloor, 'Hall 14FF', null)).toThrow(
      'Wrong plan: this drawing is of the ground floor, not Hall 14FF (first floor).',
    );
    expect(forHall(groundFloor, 'Hall 14GF', null).hall.groups).toEqual(['14']);
    // A hall with no floor in its name takes either.
    expect(forHall(groundFloor, 'Hall 14', null).hall.groups).toEqual(['14']);
  });

  it("keeps only this hall's stalls, grid and nearby labels from a plan of several halls", () => {
    const out = forHall(plan, 'Hall 8', null);
    expect(out.stalls.map((s) => s.name)).toEqual(['08-01 A', '08-01 B']);
    expect(out.groups.map((g) => g.group)).toEqual(['8']);
    expect(out.gridAreas.map((a) => a.group)).toEqual(['8']);
    expect(out.unresolved.map((u) => u.texts[0])).toEqual(['08-02 A']);
    expect(out.hall).toEqual({
      groups: ['8'],
      drawingHalls: ['8', '9', '10'],
      matchedByName: true,
    });
  });

  it('takes every hall of the drawing a joined hall is made of', () => {
    expect(forHall(plan, 'Hall 8-9', null).hall.groups).toEqual(['8', '9']);
    // By its code too.
    expect(forHall(plan, 'Main hall', 'H10').hall.groups).toEqual(['10']);
  });

  it('refuses the plan of other halls, saying whose it is', () => {
    expect(() => forHall(plan, 'Hall 5', null)).toThrow(WrongPlanError);
    expect(() => forHall(plan, 'Hall 5', null)).toThrow(
      'Wrong plan: this drawing is of Halls 8, 9 and 10, not Hall 5.',
    );
  });

  it('takes a single unnumbered hall with a warning, but not one of several', () => {
    const one = drawing([['8', '08-01 A', 100, 100]]);
    const taken = forHall(one, 'Rotunda', null);
    expect(taken.stalls).toHaveLength(1);
    expect(taken.issues[0]).toContain("check this is Rotunda's plan");
    expect(() => forHall(plan, 'Rotunda', null)).toThrow('has no hall number');
  });
});
