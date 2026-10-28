import { ITPO_PX_PER_METRE } from './itpo-hall-layout';
import type { PlanStallView } from './plan.model';
import type { StallSide } from './rule-engine';

/** A `T_STALLS` row, as the planner needs it. */
export interface ItpoStallRow {
  id: string;
  island_number: string | null;
  stall_number: string;
  description: string | null;
  location: string | null;
  stall_coordinates: Record<'top' | 'left' | 'width' | 'height', number | string | null> | null;
  layout_grid: {
    area?: string;
    stallCoords?: Array<{ x: number; y: number }>;
    borderCoords?: Array<{ x1: number; x2: number; y1: number; y2: number; isDashed?: boolean }>;
  } | null;
  category_id: number[] | null;
  is_premium: boolean | null;
  is_blocked: boolean | null;
  is_fnb_stall: boolean | null;
  is_branding_stall: boolean | null;
  is_horseshoe_stall: boolean | null;
  is_marquee_available: boolean | null;
  is_restricted_for_overseas: boolean | null;
  price?: number | string | null;
}

/**
 * A stall ITPO already has, as the planner's stall: the reverse of `itpoStall()`. Its box is its
 * position and size on the 20 px grid (a stall's width and height carry the box's 1 px stroke);
 * cells of the box that the stall does not list are cut; a dashed outer wall is an open side.
 * null for a row with no usable position.
 */
export function stallFromItpo(input: ItpoStallRow): PlanStallView | null {
  // Older rows keep their JSON as text, and their numbers as strings.
  const row: ItpoStallRow = {
    ...input,
    stall_coordinates: json(input.stall_coordinates),
    layout_grid: json(input.layout_grid),
  };
  const c = row.stall_coordinates;
  const [left, top0, width, height] = [c?.left, c?.top, c?.width, c?.height].map((v) =>
    v === null || v === undefined || v === '' ? NaN : Number(v),
  );
  if (![left, top0, width, height].every(Number.isFinite)) return null;
  const g = ITPO_PX_PER_METRE;
  const col = Math.round(left / g);
  const top = Math.round(top0 / g);
  const cols = Math.max(1, Math.round((width - 1) / g));
  const rows = Math.max(1, Math.round((height - 1) / g));

  const listed = new Set(
    (row.layout_grid?.stallCoords ?? []).map(
      (p) => `${Math.round(p.x / g) - col},${Math.round(p.y / g) - top}`,
    ),
  );
  const cutCells: Array<[number, number]> = [];
  if (listed.size) {
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) if (!listed.has(`${k},${r}`)) cutCells.push([k, r]);
    }
  }

  const sides = new Set<StallSide>();
  const x0 = col * g;
  const y0 = top * g;
  for (const b of row.layout_grid?.borderCoords ?? []) {
    if (!b.isDashed) continue;
    if (b.y1 === b.y2) sides.add(b.y1 <= y0 + 1 ? 'top' : 'bottom');
    else sides.add(b.x1 <= x0 + 1 ? 'left' : 'right');
  }

  const area = /^(\d+(?:\.\d+)?)/.exec(row.layout_grid?.area ?? '');
  const cells = cols * rows - cutCells.length;
  return {
    id: row.id,
    zoneId: null,
    islandNumber: row.island_number?.trim() || null,
    stallNumber: row.stall_number,
    x: col,
    y: top,
    width: cols,
    depth: rows,
    openSides: [...sides],
    cutCells,
    // The area ITPO shows, when it is not just the cells.
    labelArea: area && Number(area[1]) !== cells ? Number(area[1]) : null,
    // ITPO's price column is empty on rows SelfCare made: the rate card prices those.
    price:
      row.price === null || row.price === undefined || Number(row.price) <= 0
        ? null
        : Number(row.price),
    scheme: 'raw',
    categoryIds: (row.category_id ?? []).map(String),
    isPremium: !!row.is_premium,
    isBlocked: !!row.is_blocked,
    isFnb: !!row.is_fnb_stall,
    isBranding: !!row.is_branding_stall,
    isHorseshoe: !!row.is_horseshoe_stall,
    isMarqueeAvailable: !!row.is_marquee_available,
    isRestrictedForOverseas: !!row.is_restricted_for_overseas,
    isActive: true,
    location: row.location,
    description: row.description,
  };
}

/** A JSON column read as an object, whether the driver parsed it or left it as text. */
function json<T>(value: T | string | null): T | null {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
