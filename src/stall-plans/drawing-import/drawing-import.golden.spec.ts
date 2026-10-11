import { readFileSync } from 'fs';

import { runDrawingJob } from './drawing-import.job';
import { forHall, WrongPlanError } from './hall-match';
import type { ExtractionResult } from './stall-extraction';

/**
 * Golden check against the real IITF 2026 plan of Halls 8 to 11, for ITPO's Hall 11. The drawing
 * is not part of this repository: set PDF_IMPORT_FIXTURE to its path to run it, e.g.
 *   PDF_IMPORT_FIXTURE=~/Downloads/56d0159d285ffc30f61d883559beb5ae.pdf npx jest drawing-import.golden
 */
const fixture = process.env.PDF_IMPORT_FIXTURE;
const run = fixture ? describe : describe.skip;

run('the IITF 2026 plan of Halls 8 to 11, for Hall 11', () => {
  jest.setTimeout(120_000);
  let result: ExtractionResult;
  beforeAll(async () => {
    const out = await runDrawingJob({
      kind: 'stalls',
      data: new Uint8Array(readFileSync(fixture!)),
      page: 1,
    });
    if (!out.ok || out.kind !== 'stalls') throw new Error('The plan could not be read');
    result = out.result;
  });

  it('finds the four halls, each on its own grid', () => {
    expect(result.groups.map((g) => g.group)).toEqual(['11', '10', '9', '8']);
    for (const g of result.groups) expect(g.rms).toBeLessThan(0.05);
  });

  it("keeps only Hall 11's stalls, every one named once, the wall lines with their block", () => {
    const hall = forHall(result, 'Hall 11', null);
    expect(hall.hall).toEqual({
      groups: ['11'],
      drawingHalls: ['11', '10', '9', '8'],
      matchedByName: true,
    });
    expect(hall.stalls).toHaveLength(71);
    const names = hall.stalls.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    // Only the hall master's and first aid's booths have no block: they are not stalls.
    expect(hall.stalls.filter((s) => !s.blockId).map((s) => s.name)).toEqual([
      'HALL MASTER',
      'FIRST AID Booth',
    ]);
    for (const name of [
      '11-13 B',
      '11-13 G',
      '11-13 L',
      '11-05 C',
      '11-05 F',
      '11-01 G',
      '11-01 I',
    ])
      expect(names).toContain(name);
    expect(
      hall.stalls
        .filter((s) => s.shape === 'L-shape')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['11-10 C', '11-13 H']);
    // The drawing's grid of Hall 11: 39 × 124 m, the size of ITPO's hall inside its walls.
    const xs = hall.gridAreas[0].outline.map((p) => p.x);
    const zs = hall.gridAreas[0].outline.map((p) => p.z);
    expect([Math.min(...xs) + 0, Math.max(...zs)]).toEqual([0, 124]);
  });

  it('is the wrong plan for a hall it does not draw', () => {
    expect(() => forHall(result, 'Hall 5', null)).toThrow(WrongPlanError);
  });
});
