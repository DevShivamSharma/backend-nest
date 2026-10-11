import { blocksFromNeighbours } from './block-chain';
import type { ExtractedStall } from './stall-extraction';

/** A 3 × 3 m stall at (x, z), metres, with a letter and maybe a block. */
function stall(
  key: string,
  x: number,
  z: number,
  letter: string | null,
  blockId: string | null = null,
) {
  return {
    key,
    group: '11',
    blockId,
    letter,
    name: blockId && letter ? `${blockId} ${letter}` : `Stall ${key}`,
    outline: [
      { x, z },
      { x: x + 3, z },
      { x: x + 3, z: z + 3 },
      { x, z: z + 3 },
    ],
    issues: blockId ? [] : [{ code: 'NO_BLOCK', severity: 'warning', message: 'No block.' }],
  } as unknown as ExtractedStall;
}

const names = (list: ExtractedStall[]) => list.map((s) => s.name);

describe('blocks along a line of stalls', () => {
  it('carries a block printed once along its line and round the corner', () => {
    // 11-13 A1, A down the left wall; B, C along the top; D round the corner, past a 1 m gap.
    const out = blocksFromNeighbours([
      stall('a1', 0, 3, 'A1', '11-13'),
      stall('a', 0, 6, 'A', '11-13'),
      stall('b', 3, 0, 'B'),
      stall('c', 6, 0, 'C'),
      stall('d', 10, 3, 'D'),
    ]);
    expect(names(out)).toEqual(['11-13 A1', '11-13 A', '11-13 B', '11-13 C', '11-13 D']);
    expect(out[2].issues).toEqual([
      expect.objectContaining({ code: 'NO_BLOCK', severity: 'info' }),
    ]);
  });

  it('crosses one letter the drawing left without an outline, in the same column only', () => {
    const out = blocksFromNeighbours([
      stall('a', 0, 20, 'A', '11-05'),
      // B has no outline: 5 m of the column with no stall.
      stall('c', 0, 12, 'C'),
      stall('far', 8, 12, 'C'),
    ]);
    expect(names(out)).toEqual(['11-05 A', '11-05 C', 'Stall far']);
  });

  it('prefers the next letter, and never guesses between two blocks', () => {
    const out = blocksFromNeighbours([
      stall('g', 0, 0, 'G', '11-13'),
      // F of another block is near too, but G is H's next letter.
      stall('f', 3, 4, 'F', '11-14'),
      stall('h', 3, 0, 'H'),
      // Two blocks, both one letter away: left as it is.
      stall('x1', 20, 0, 'B', '11-01'),
      stall('x2', 26, 0, 'B', '11-02'),
      stall('y', 23, 0, 'C'),
    ]);
    expect(names(out)).toEqual(['11-13 G', '11-14 F', '11-13 H', '11-01 B', '11-02 B', 'Stall y']);
    expect(out[5].issues[0]).toEqual(
      expect.objectContaining({ code: 'NO_BLOCK', severity: 'warning' }),
    );
  });
});
