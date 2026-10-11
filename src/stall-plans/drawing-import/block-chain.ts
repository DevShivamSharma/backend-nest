import type { ExtractedStall } from './stall-extraction';
import type { Point } from './stall-footprint';

/** Stalls this close (metres) count as neighbours along a line: a corner may have a 1 m gap. */
const NEAR = 1.5;
/** Across a skipped letter (a stall the drawing left without an outline), along the same line. */
const SKIP_GAP = 6;
/** A line may skip one letter (J, then L), never more. */
const MAX_STEP = 2;

/**
 * ITPO numbers a line of stalls along a wall as one block that turns the corners: 11-13 A1, A on
 * the left wall, then B to G along the top, then H to L down the right, with the block number
 * printed once. The drawing gives those stalls their letter and no block. Here a stall with a
 * letter and no block takes the block of a neighbour whose letter is next to its own in the
 * line, as far as the line goes; across a corner's passage, and across one letter the drawing left
 * without an outline. Never a guess between two blocks: when neighbours disagree, the
 * stall keeps its warning.
 */
export function blocksFromNeighbours(stalls: ExtractedStall[]): ExtractedStall[] {
  const out = stalls.map((s) => ({ ...s, issues: [...s.issues] }));
  const boxes = out.map((s) => box(s.outline));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      const own = letterIndex(s.letter);
      if (s.blockId || own === null) continue;
      // The next letter first (G for H); a skipped one (F for H) only when there is none.
      const byStep: Array<Set<string>> = Array.from({ length: MAX_STEP + 1 }, () => new Set());
      for (let j = 0; j < out.length; j++) {
        const n = out[j];
        const theirs = letterIndex(n.letter);
        if (i === j || !n.blockId || theirs === null) continue;
        const step = Math.abs(own - theirs);
        if (step === 0 || step > MAX_STEP || !neighbours(boxes[i], boxes[j], step)) continue;
        byStep[step].add(n.blockId);
      }
      const blocks = byStep.find((b) => b.size) ?? new Set<string>();
      if (blocks.size !== 1) continue;
      const [block] = blocks;
      const from = out.find((n, j) => n.blockId === block && gap(boxes[i], boxes[j]) <= SKIP_GAP);
      out[i] = {
        ...s,
        blockId: block,
        name: `${block} ${s.letter}`,
        issues: [
          ...s.issues.filter((x) => x.code !== 'NO_BLOCK'),
          {
            code: 'NO_BLOCK',
            severity: 'info',
            message: `Block ${block} taken from the line it continues (next to ${from?.name ?? block}).`,
          },
        ],
      };
      changed = true;
    }
  }
  return out;
}

/** A letter's place in the line: A is 0, B 1…; "A1" is A. null for anything else. */
function letterIndex(letter: string | null): number | null {
  const m = letter && /^([A-Z])\d?$/.exec(letter.trim().toUpperCase());
  return m ? m[1].charCodeAt(0) - 65 : null;
}

interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function box(outline: Point[]): Box {
  const xs = outline.map((p) => p.x);
  const zs = outline.map((p) => p.z);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

/** Next to each other in a line: close, or one letter apart in the same row or column. */
function neighbours(a: Box, b: Box, step: number): boolean {
  const d = gap(a, b);
  if (d <= NEAR) return true;
  if (step !== 2 || d > SKIP_GAP) return false;
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.min(a1 - a0, b1 - b0);
  // The same column (x ranges agree) or the same row (z ranges agree).
  return (
    overlap(a.minX, a.maxX, b.minX, b.maxX) >= 0.8 || overlap(a.minZ, a.maxZ, b.minZ, b.maxZ) >= 0.8
  );
}

/** The gap between two boxes, 0 when they touch or overlap. */
function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(dx, dz);
}
