import type { OverlayImage } from './overlay-image';
import type { ExtractedStall, UnresolvedLabel } from './stall-extraction';

/** What the vision model noticed. A hint to look at, never a place to put a stall. */
export interface AiFinding {
  kind: 'missing' | 'extra' | 'wrong';
  /** The stall it is about (`missing` has none). */
  stallKey: string | null;
  message: string;
  /** Page point the model pointed at, for a missing stall. */
  at: { x: number; y: number } | null;
  /** Index of the drawing's own unresolved label close to `at`: the geometry's answer to it. */
  unresolved: number | null;
}

export interface AiCheck {
  status: 'done' | 'skipped' | 'failed';
  model: string | null;
  findings: AiFinding[];
  message?: string;
}

/** The most findings kept: a model that flags everything has found nothing. */
const MAX_FINDINGS = 25;

export function checkPrompt(names: readonly string[]): string {
  return [
    'You check a computer-extracted stall layout of an exhibition hall against its drawing.',
    'In the picture, grey lines are the original drawing. Blue outlines are the stalls that were',
    'found, each with its number in red. Orange circles mark labels that have no stall outline.',
    `The stalls found, by number: ${names.map((n, i) => `${i + 1} = ${n}`).join('; ')}.`,
    '',
    'Report only clear problems:',
    '- "missing": a stall drawn in the original lines that has no blue outline. Give its centre as',
    '  x and y, fractions of the picture width and height (0 to 1, from the top-left).',
    '- "extra": a blue outline that is not a stall in the drawing. Give its number.',
    '- "wrong": a blue outline that does not match the drawn stall (shape, size) or whose name',
    '  looks wrong. Give its number.',
    'Answer with JSON only, in this shape, with empty lists when all is well:',
    '{"missing":[{"x":0.5,"y":0.5,"note":"..."}],"extra":[{"stall":"11-01 A","note":"..."}],"wrong":[{"stall":"11-02 B","note":"..."}]}',
    'Never invent a stall name that is not in the list above.',
  ].join('\n');
}

/**
 * The model's answer as findings. Names are matched to the stalls found, and anything else is
 * dropped; a missing stall's spot is only kept as a point, matched to the geometry's own
 * unresolved label when one is near.
 */
export function parseFindings(
  text: string,
  stalls: readonly ExtractedStall[],
  unresolved: readonly UnresolvedLabel[],
  image: OverlayImage,
  /** How far, in page points, a label may be from the spot to count as the same thing. */
  near: number,
): AiFinding[] {
  const body = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))?.[0];
  if (!body) return [];
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const list = (key: string): unknown[] => {
    const value = (data as Record<string, unknown>)[key];
    return Array.isArray(value) ? value : [];
  };
  const byName = new Map(stalls.map((s) => [s.name.toLowerCase(), s]));
  const note = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const out: AiFinding[] = [];

  for (const item of list('missing')) {
    const { x, y, note: n } = (item ?? {}) as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 1 || y < 0 || y > 1)
      continue;
    const at = {
      x: image.originX + (x * image.width) / image.scale,
      y: image.originY + (y * image.height) / image.scale,
    };
    let best = -1;
    let bestDistance = near;
    unresolved.forEach((u, i) => {
      const d = Math.hypot(u.x - at.x, u.y - at.y);
      if (d < bestDistance) [best, bestDistance] = [i, d];
    });
    out.push({
      kind: 'missing',
      stallKey: null,
      message: note(n) || 'A stall in the drawing has no outline.',
      at,
      unresolved: best >= 0 ? best : null,
    });
  }
  for (const [kind, key] of [
    ['extra', 'extra'],
    ['wrong', 'wrong'],
  ] as const) {
    for (const item of list(key)) {
      const { stall, note: n } = (item ?? {}) as Record<string, unknown>;
      const found =
        typeof stall === 'number'
          ? stalls[stall - 1]
          : typeof stall === 'string'
            ? (stalls[Number(stall) - 1] ?? byName.get(stall.trim().toLowerCase()))
            : undefined;
      if (!found) continue;
      out.push({
        kind,
        stallKey: found.key,
        message:
          note(n) ||
          (kind === 'extra'
            ? 'This outline may not be a stall.'
            : 'This outline may not match the drawing.'),
        at: null,
        unresolved: null,
      });
    }
  }
  return out.slice(0, MAX_FINDINGS);
}
