import { readFileSync } from 'fs';
import { readPageVectors } from './pdf-vectors';
import { extractStalls, stallLayerModes } from './stall-extraction';

/**
 * Golden check against the real IITF 2026 Halls 8-11 plan. The drawing is not part of this
 * repository: set PDF_IMPORT_FIXTURE to its path to run it, e.g.
 *   PDF_IMPORT_FIXTURE=~/plans/H8-11_IITF26.pdf npx jest stall-extraction.golden
 */
const fixture = process.env.PDF_IMPORT_FIXTURE;
const run = fixture ? describe : describe.skip;

run('extractStalls on the IITF 2026 Halls 8-11 plan', () => {
  jest.setTimeout(60_000);
  let result: ReturnType<typeof extractStalls>;
  beforeAll(async () => {
    // As the import endpoint reads it: stall layers only, hatching as midpoints.
    result = extractStalls(
      await readPageVectors(new Uint8Array(readFileSync(fixture!)), 1, {
        layerMode: stallLayerModes,
      }),
    );
  });

  it('finds the four halls on their own grids', () => {
    expect(result.groups.map((g) => g.group)).toEqual(['11', '10', '9', '8']);
    for (const g of result.groups) expect(g.rms).toBeLessThan(0.05);
  });

  it('keeps both L-shaped stalls whole', () => {
    const ls = result.stalls.filter((s) => s.shape === 'L-shape');
    expect(ls.map((s) => s.area).sort((a, b) => a - b)).toEqual([30, 100.5]);
    expect(ls.every((s) => s.outline.length === 6)).toBe(true);
  });

  it('leaves the detail drawing out and flags the known conflicts', () => {
    expect(result.stalls.length).toBeGreaterThanOrEqual(140);
    expect(result.excluded.length).toBeGreaterThan(0);
    expect(result.stalls.find((s) => s.name === '11-09 B')?.issues.map((i) => i.code)).toContain(
      'AREA_MISMATCH',
    );
    expect(result.unresolved.length).toBe(3);
    expect(new Set(result.stalls.map((s) => s.name)).size).toBe(result.stalls.length);
  });
});
