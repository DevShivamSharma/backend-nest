import { ITPO_PX_PER_METRE } from '../integrations/itpo/itpo-hall-layout';
import { forSale } from '../stall-plans/pricing/stall-price';
import { stallLabel } from '../stall-plans/published-stalls';
import type { PublishedStallEntity } from '../stall-plans/stall-plan.entity';

/** SelfCare's body version (docs/itpo-stall-push-endpoint-prompt.md §4). */
export const ITPO_SCHEMA_VERSION = 1;

/**
 * SelfCare's own stalls are one pixel wider and taller than their metres (a 5 × 6 m stall is
 * 101 × 121 px in the contract's example and in `T_STALLS`): the box's stroke. Pushed stalls
 * match them, so they draw like SelfCare's.
 */
const STROKE_PX = 1;
/** Positions are stored to the millimetre; this keeps 19.9999 m on the 20 m grid line. */
const EPS = 1e-6;

export interface ItpoStall {
  platformStallId: string;
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
  layout_grid: { area: string; stallCoords: Array<{ x: number; y: number }> };
  no_of_open_sides: number;
  category_id: number[];
  is_premium: boolean;
  is_blocked: boolean;
  is_fnb_stall: boolean;
  is_branding_stall: boolean;
  is_horseshoe_stall: boolean;
  is_marquee_available: boolean;
  is_restricted_for_overseas: boolean;
  location: string | null;
  description: string | null;
}

export interface ItpoPushBody {
  schemaVersion: typeof ITPO_SCHEMA_VERSION;
  deliveryId: string;
  kind: 'plan.published';
  sentAt: string;
  event: { itpoBookingId: string; platformEventId: string; name: string };
  hall: { itpoHallId: number; platformHallId: string; name: string; floorVersion: number };
  plan: { revision: number; publishedAt: string; pxPerMetre: number; stalls: ItpoStall[] };
}

export interface ItpoPushInput {
  deliveryId: string;
  sentAt: Date;
  event: { id: string; name: string; venueEventId: string | null };
  hall: { id: string; name: string; itpoId: string | null; floorVersion: number };
  plan: { revision: number; publishedAt: Date };
  stalls: readonly PublishedStallEntity[];
  /** Our category id → SelfCare's `T_CODE_MASTER` id, for the mapped ones. */
  categories: ReadonlyMap<string, number>;
  /** Our category id → its name, for the message about unmapped ones. */
  categoryNames: ReadonlyMap<string, string>;
}

/** Metres to SelfCare pixels, whole: a pixel is 5 cm, finer than any stall is placed. */
const px = (metres: number): number => Math.round(metres * ITPO_PX_PER_METRE);

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
  } else if (!Number.isSafeInteger(Number(input.hall.itpoId))) {
    out.push(`The hall’s SelfCare id “${input.hall.itpoId}” is not a number.`);
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
    deliveryId: input.deliveryId,
    kind: 'plan.published',
    sentAt: input.sentAt.toISOString(),
    event: {
      itpoBookingId: input.event.venueEventId!,
      platformEventId: input.event.id,
      name: input.event.name,
    },
    hall: {
      itpoHallId: Number(input.hall.itpoId),
      platformHallId: input.hall.id,
      name: input.hall.name,
      floorVersion: input.hall.floorVersion,
    },
    plan: {
      revision: input.plan.revision,
      publishedAt: input.plan.publishedAt.toISOString(),
      pxPerMetre: ITPO_PX_PER_METRE,
      stalls: stalls.map((s) => itpoStall(s, input.categories)),
    },
  };
}

export function itpoStall(
  s: PublishedStallEntity,
  categories: ReadonlyMap<string, number>,
): ItpoStall {
  const left = px(s.x);
  const top = px(s.y);
  const width = px(s.width) + STROKE_PX;
  const height = px(s.depth) + STROKE_PX;
  return {
    platformStallId: s.stallId,
    island_number: s.islandNumber ?? '',
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
      area: `${Number((s.width * s.depth).toFixed(2))}sqm`,
      stallCoords: gridPoints(s),
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
    location: s.location,
    description: s.description,
  };
}

/**
 * The 1 m cells of SelfCare's 20 px grid the stall covers, by their top-left corners, row by
 * row. A stall on whole metres gives width × depth points, as SelfCare's own rows have.
 */
function gridPoints(s: PublishedStallEntity): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const [firstCol, endCol] = [Math.floor(s.x + EPS), Math.ceil(s.x + s.width - EPS)];
  const [firstRow, endRow] = [Math.floor(s.y + EPS), Math.ceil(s.y + s.depth - EPS)];
  for (let row = firstRow; row < endRow; row++) {
    for (let col = firstCol; col < endCol; col++) {
      points.push({ x: col * ITPO_PX_PER_METRE, y: row * ITPO_PX_PER_METRE });
    }
  }
  return points;
}
