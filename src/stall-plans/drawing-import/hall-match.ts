import { blocksFromNeighbours } from './block-chain';
import type { ExtractionResult } from './stall-extraction';

/** The stalls of one hall of a CAD plan, and which of the drawing's halls they are. */
export interface HallStalls extends ExtractionResult {
  hall: {
    /** The drawing's halls taken as this hall ("8"; "8", "9", "10" for Hall 8-9-10). */
    groups: string[];
    /** Every hall the drawing has stalls of, by number. */
    drawingHalls: string[];
    /** False when neither the drawing nor the hall names a number to match by. */
    matchedByName: boolean;
  };
}

/** The drawing is of another hall: the planner shows the message as it is. */
export class WrongPlanError extends Error {}

/** A label is counted with a hall when it lies this far (page points) around its stalls. */
const AROUND = 40;

/**
 * The hall numbers in a hall's name or code ("Hall 8-9-10" → 8, 9, 10; "H5" → 5). "Hall 12A" is
 * hall 12A, not 12; a trailing G, F, GF or FF is the floor ("Hall 5G", "Hall 14GF" are halls 5
 * and 14), as the drawing's block numbers have it.
 */
export function hallNumbers(names: ReadonlyArray<string | null | undefined>): Set<string> {
  return new Set(
    names
      .filter((n): n is string => !!n)
      .flatMap((n) => [...n.toUpperCase().matchAll(/(\d+)(GF|FF|[A-Z]?)(?![A-Z])/g)])
      .map((m) => String(Number(m[1])) + (/^(?:GF|FF|G|F)$/.test(m[2]) ? '' : m[2])),
  );
}

/** The floor a hall's name or code states ("Hall 14GF", "H5G", "Hall 4 First Floor"); null when none. */
export function hallFloor(names: ReadonlyArray<string | null | undefined>): 'GF' | 'FF' | null {
  const text = names.filter((n): n is string => !!n).join(' ');
  const ground = /ground\s*floor|\bg\.?f\b|\d(?:gf|g)\b/i.test(text);
  const first = /first\s*floor|\bf\.?f\b|\d(?:ff|f)\b/i.test(text);
  return ground === first ? null : ground ? 'GF' : 'FF';
}

const FLOOR_NAME = { GF: 'ground floor', FF: 'first floor' } as const;

/**
 * Only the stalls of the hall being planned, out of a drawing that may have several halls: the
 * drawing's halls whose number is in the hall's name or code. A drawing of other halls only is
 * the wrong plan. When there is nothing to match by (the drawing or the hall names no number),
 * a drawing of one hall is taken, with a warning to check it; one of several halls is not.
 */
export function forHall(
  result: ExtractionResult,
  hallName: string,
  hallCode: string | null,
): HallStalls {
  // Hall 14 GF and Hall 14 FF share their number: the floor tells their plans apart.
  const floor = hallFloor([hallName, hallCode]);
  if (floor && result.floor && floor !== result.floor) {
    throw new WrongPlanError(
      `Wrong plan: this drawing is of the ${FLOOR_NAME[result.floor]}, not ${hallName} ` +
        `(${FLOOR_NAME[floor]}). Upload the plan of ${hallName}.`,
    );
  }

  const drawingHalls = result.groups.map((g) => g.group).filter((g) => g !== '?');
  const numbers = hallNumbers([hallName, hallCode]);
  const matched = drawingHalls.filter((g) => numbers.has(g));
  if (matched.length) return only(result, matched, drawingHalls, true);

  const named = (list: string[]) =>
    list.length > 1
      ? `Halls ${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
      : `Hall ${list[0]}`;
  if (drawingHalls.length && numbers.size) {
    throw new WrongPlanError(
      `Wrong plan: this drawing is of ${named(drawingHalls)}, not ${hallName}. Upload the plan of ${hallName}.`,
    );
  }
  const groups = result.groups.map((g) => g.group);
  if (groups.length > 1) {
    throw new WrongPlanError(
      `This drawing has ${named(drawingHalls.length ? drawingHalls : groups)}, and ${hallName} has no ` +
        'hall number to tell which is this hall. Upload a plan of this hall only.',
    );
  }
  const out = only(result, groups, drawingHalls, false);
  out.issues = [
    `${numbers.size ? 'The drawing names no' : `Neither the drawing nor ${hallName} names a`} hall number to match by: check this is ${hallName}'s plan before importing.`,
    ...out.issues,
  ];
  return out;
}

/** The result cut down to some of its halls: their calibration, stalls, grid and labels. */
function only(
  result: ExtractionResult,
  groups: string[],
  drawingHalls: string[],
  matchedByName: boolean,
): HallStalls {
  const keep = new Set(groups);
  // Lines along the walls carry their block number once: the rest of the line takes it.
  const stalls = blocksFromNeighbours(result.stalls.filter((s) => keep.has(s.group)));
  // Labels and left-out drawings carry no hall: those around this hall's stalls are kept.
  const xs = stalls.flatMap((s) => s.outlinePt.map((p) => p.x));
  const ys = stalls.flatMap((s) => s.outlinePt.map((p) => p.z));
  const box = xs.length
    ? {
        minX: Math.min(...xs) - AROUND,
        maxX: Math.max(...xs) + AROUND,
        minY: Math.min(...ys) - AROUND,
        maxY: Math.max(...ys) + AROUND,
      }
    : null;
  const near = (x: number, y: number) =>
    !!box && x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  return {
    ...result,
    groups: result.groups.filter((g) => keep.has(g.group)),
    stalls,
    gridAreas: result.gridAreas.filter((a) => keep.has(a.group)),
    unresolved: result.unresolved.filter((u) => near(u.x, u.y)),
    excluded: result.excluded.filter((e) => e.outlinePt.some((p) => near(p.x, p.z))),
    hall: { groups, drawingHalls, matchedByName },
  };
}
