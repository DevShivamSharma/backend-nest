import { ITPO_PX_PER_METRE } from '../integrations/itpo/itpo-hall-layout';
import type { StallSide } from '../rules/rule-engine';
import { forSale } from '../stall-plans/pricing/stall-price';
import { stallLabel } from '../stall-plans/published-stalls';
import type { PublishedStallEntity } from '../stall-plans/stall-plan.entity';

/** SelfCare's body version (docs/itpo-stall-push-endpoint-prompt.md §4). */
export const ITPO_SCHEMA_VERSION = 1;

/**
 * SelfCare's own stalls are one pixel wider and taller than their cells (a 4 × 6 stall is
 * 81 × 121 px in the contract's reference row and in `T_STALLS`): the box's stroke. Pushed
 * stalls match them, so they draw like SelfCare's.
 */
const STROKE_PX = 1;
/**
 * SelfCare draws a stall's right and bottom walls 2 px inside the last cell's far edge
 * (`left + cols × 20 − 2`), so neighbours' walls do not overlap: the contract's "+18".
 */
const FAR_WALL_INSET_PX = 2;
/** Positions are stored to the millimetre; this keeps 19.9999 m on the 20 m grid line. */
const EPS = 1e-6;

export interface ItpoStall {
  island_number: string;
  stall_number: string;
  stall_name: string;
  stall_coordinates: {
    top: number;
    left: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  layout_grid: {
    area: string;
    stallCoords: Array<{ x: number; y: number }>;
    borderCoords: Array<{ x1: number; x2: number; y1: number; y2: number; isDashed: boolean }>;
  };
  no_of_open_sides: number;
  category_id: number[];
  is_premium: boolean;
  is_blocked: boolean;
  is_fnb_stall: boolean;
  is_branding_stall: boolean;
  is_horseshoe_stall: boolean;
  is_marquee_available: boolean;
  is_restricted_for_overseas: boolean;
  /** Left out when we have none: the receiver takes a string or nothing, not null. */
  location?: string;
  description?: string;
}

/** Exactly the receiver's fields (contract, schemaVersion 1): nothing it does not read. */
export interface ItpoPushBody {
  schemaVersion: typeof ITPO_SCHEMA_VERSION;
  kind: 'plan.published';
  deliveryId: string;
  event: { itpoBookingId: string };
  hall: { itpoHallId: number };
  plan: { revision: number; stalls: ItpoStall[] };
}

export interface ItpoPushInput {
  deliveryId: string;
  event: { venueEventId: string | null };
  hall: { itpoId: string | null };
  plan: { revision: number };
  stalls: readonly PublishedStallEntity[];
  /** Our category id → SelfCare's `T_CODE_MASTER` id, for the mapped ones. */
  categories: ReadonlyMap<string, number>;
  /** Our category id → its name, for the message about unmapped ones. */
  categoryNames: ReadonlyMap<string, string>;
}

/** The receiver's integers (hall id, revision, category ids) are 32-bit signed. */
export const INT32_MAX = 2_147_483_647;

/** Only active stalls go: SelfCare inserts every pushed row as active and has no flag for it. */
const pushed = (stalls: readonly PublishedStallEntity[]) => stalls.filter((s) => s.isActive);

/** Why this hall cannot be pushed, one sentence each; empty when it can. */
export function itpoPushProblems(input: ItpoPushInput): string[] {
  const out: string[] = [];
  if (!input.event.venueEventId) {
    out.push(
      'The event has no SelfCare booking id (e.g. H-20260800050). Enter it as the event’s id in your system.',
    );
  }
  if (!input.hall.itpoId) {
    out.push('This hall has no SelfCare hall id. Set it on the hall’s page.');
  } else if (!/^\d+$/.test(input.hall.itpoId) || Number(input.hall.itpoId) > INT32_MAX) {
    out.push(
      `The hall’s SelfCare id “${input.hall.itpoId}” is not a whole number SelfCare can take.`,
    );
  }
  // SelfCare needs an island number on every stall (contract: required, non-empty).
  const noIsland = pushed(input.stalls)
    .filter((s) => !s.islandNumber?.trim())
    .map((s) => s.stallNumber)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (noIsland.length) {
    const shown = noIsland.slice(0, 5).join(', ') + (noIsland.length > 5 ? '…' : '');
    out.push(
      `${noIsland.length === 1 ? 'A stall has' : `${noIsland.length} stalls have`} no island number: ${shown}. SelfCare needs one on every stall.`,
    );
  }
  // Only stalls for sale need a category SelfCare knows; a blocked stall sells nothing.
  const missing = new Set<string>();
  for (const s of pushed(input.stalls)) {
    if (!forSale(s)) continue;
    for (const id of s.categoryIds) if (!input.categories.has(id)) missing.add(id);
  }
  if (missing.size) {
    const names = [...missing].map((id) => input.categoryNames.get(id) ?? id).sort();
    out.push(
      `${names.length === 1 ? 'A category has' : `${names.length} categories have`} no SelfCare id: ${names.join(', ')}. Set ${names.length === 1 ? 'it' : 'them'} on the Categories page.`,
    );
  }
  return out;
}

/** The body SelfCare's endpoint takes. Call only when `itpoPushProblems` is empty. */
export function itpoPushBody(input: ItpoPushInput): ItpoPushBody {
  const stalls = [...pushed(input.stalls)].sort((a, b) =>
    stallLabel(a).localeCompare(stallLabel(b), 'en', { numeric: true }),
  );
  return {
    schemaVersion: ITPO_SCHEMA_VERSION,
    kind: 'plan.published',
    deliveryId: input.deliveryId,
    event: { itpoBookingId: input.event.venueEventId! },
    hall: { itpoHallId: Number(input.hall.itpoId) },
    plan: {
      revision: input.plan.revision,
      stalls: stalls.map((s) => itpoStall(s, input.categories)),
    },
  };
}

export function itpoStall(
  s: PublishedStallEntity,
  categories: ReadonlyMap<string, number>,
): ItpoStall {
  const box = cellBox(s);
  const kept = keptCells(box, s);
  const g = ITPO_PX_PER_METRE;
  const left = box.col * g;
  const top = box.row * g;
  const width = box.cols * g + STROKE_PX;
  const height = box.rows * g + STROKE_PX;
  return {
    island_number: s.islandNumber!.trim(),
    stall_number: s.stallNumber,
    // We keep no stall name; SelfCare's own rows say "NA".
    stall_name: 'NA',
    stall_coordinates: {
      top,
      left,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2,
    },
    layout_grid: {
      // SelfCare's area is its cell count: a cut stall's is less than its box.
      area: `${kept.length}sqm`,
      stallCoords: gridPoints(box, kept),
      borderCoords: borders(box, kept, s.openSides),
    },
    no_of_open_sides: s.openSides.length,
    category_id: s.categoryIds.flatMap((id) => {
      const itpo = categories.get(id);
      return itpo === undefined ? [] : [itpo];
    }),
    is_premium: s.isPremium,
    is_blocked: s.isBlocked,
    is_fnb_stall: s.isFnb,
    is_branding_stall: s.isBranding,
    is_horseshoe_stall: s.isHorseshoe,
    is_marquee_available: s.isMarqueeAvailable,
    is_restricted_for_overseas: s.isRestrictedForOverseas,
    ...(s.location !== null && { location: s.location }),
    ...(s.description !== null && { description: s.description }),
  };
}

/** The 1 m cells a stall covers: first column and row, and how many of each. */
interface CellBox {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/**
 * One box drives the coordinates, the cells and the walls, so they always agree. A stall off
 * whole metres takes every cell it touches, as SelfCare can only draw whole cells.
 */
function cellBox(s: PublishedStallEntity): CellBox {
  const col = Math.floor(s.x + EPS);
  const row = Math.floor(s.y + EPS);
  return {
    col,
    row,
    cols: Math.max(1, Math.ceil(s.x + s.width - EPS) - col),
    rows: Math.max(1, Math.ceil(s.y + s.depth - EPS) - row),
  };
}

/**
 * The box's cells the stall keeps, as [column, row] within the box: all of them less the ones
 * cut away. A cut cell of a stall off whole metres goes by the box cell its corner falls in.
 */
function keptCells(b: CellBox, s: PublishedStallEntity): Array<[number, number]> {
  const cut = new Set(
    s.cutCells.map(
      ([c, r]) => `${Math.floor(s.x + c + EPS) - b.col},${Math.floor(s.y + r + EPS) - b.row}`,
    ),
  );
  const kept: Array<[number, number]> = [];
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) if (!cut.has(`${c},${r}`)) kept.push([c, r]);
  }
  return kept;
}

/** The kept cells' top-left corners on SelfCare's 20 px grid, row by row (a 4 × 6 stall: 24). */
function gridPoints(
  b: CellBox,
  kept: ReadonlyArray<[number, number]>,
): Array<{ x: number; y: number }> {
  const g = ITPO_PX_PER_METRE;
  return kept.map(([c, r]) => ({ x: (b.col + c) * g, y: (b.row + r) * g }));
}

/**
 * One segment per kept cell edge that has no kept cell beyond it, cell by cell, row by row,
 * top, left, right, bottom, as SelfCare's own rows have; a cut cell gets walls round it like
 * the stall's outside. A right or bottom wall sits `FAR_WALL_INSET_PX` inside its cell. An
 * open side is dashed on the stall's outer line only, never round a cut.
 */
function borders(
  b: CellBox,
  kept: ReadonlyArray<[number, number]>,
  open: readonly StallSide[],
): ItpoStall['layout_grid']['borderCoords'] {
  const g = ITPO_PX_PER_METRE;
  const has = new Set(kept.map(([c, r]) => `${c},${r}`));
  const out: ItpoStall['layout_grid']['borderCoords'] = [];
  for (const [c, r] of kept) {
    const x = (b.col + c) * g;
    const y = (b.row + r) * g;
    const far = (n: number) => n + g - FAR_WALL_INSET_PX;
    if (!has.has(`${c},${r - 1}`)) {
      out.push({ x1: x, x2: x + g, y1: y, y2: y, isDashed: r === 0 && open.includes('top') });
    }
    if (!has.has(`${c - 1},${r}`)) {
      out.push({ x1: x, x2: x, y1: y, y2: y + g, isDashed: c === 0 && open.includes('left') });
    }
    if (!has.has(`${c + 1},${r}`)) {
      const isDashed = c === b.cols - 1 && open.includes('right');
      out.push({ x1: far(x), x2: far(x), y1: y, y2: y + g, isDashed });
    }
    if (!has.has(`${c},${r + 1}`)) {
      const isDashed = r === b.rows - 1 && open.includes('bottom');
      out.push({ x1: x, x2: x + g, y1: far(y), y2: far(y), isDashed });
    }
  }
  return out;
}
