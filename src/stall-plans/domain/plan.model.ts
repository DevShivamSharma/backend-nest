import type { StallSide } from './rule-engine';
import type { Point } from './plan.types';

/** How a stall is built: with the organiser's shell scheme, or bare floor. */
export const STALL_SCHEMES = ['shell', 'raw'] as const;
export type StallScheme = (typeof STALL_SCHEMES)[number];

/** A drawing on the plan that is not sold; the rules do not check it. */
export const PLAN_OBJECT_KINDS = ['line', 'rect', 'circle', 'polyline', 'text'] as const;
export type PlanObjectKind = (typeof PLAN_OBJECT_KINDS)[number];

export interface PlanZoneView {
  id: string;
  name: string;
  color: string;
  polygon: Point[];
  /** m² */
  area: number;
}

export interface PlanStallView {
  id: string;
  zoneId: string | null;
  islandNumber: string | null;
  stallNumber: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  /** Cells cut out, [column, row] from the top-left. */
  cutCells: Array<[number, number]>;
  /** m² the hall drawing writes on the stall, sold and sent as its area; null: its cells. */
  labelArea: number | null;
  /** ₹ before GST set on this stall itself; it comes before the rate card's price. Null: the card prices it. */
  price: number | null;
  scheme: StallScheme;
  categoryIds: string[];
  isPremium: boolean;
  isBlocked: boolean;
  isFnb: boolean;
  isBranding: boolean;
  isHorseshoe: boolean;
  isMarqueeAvailable: boolean;
  isRestrictedForOverseas: boolean;
  isActive: boolean;
  location: string | null;
  description: string | null;
}

export interface PlanSeatView {
  id: string;
  zoneId: string | null;
  rowLabel: string;
  seatNumber: number;
  x: number;
  y: number;
  width: number;
  depth: number;
  categoryId: string | null;
}

export interface PlanObjectView {
  id: string;
  kind: PlanObjectKind;
  /** Floor metres; line 2, rect 2 opposite corners, circle centre and edge, polyline 2+, text 1. */
  points: Point[];
  text: string | null;
  color: string;
}

/** What a plan holds: the zones, the stalls and seats on them, and the drawings. */
export interface PlanContent {
  zones: PlanZoneView[];
  stalls: PlanStallView[];
  seats: PlanSeatView[];
  objects: PlanObjectView[];
}

/** A stall as it was published: the plan's stall, with its price at that time. */
export interface PublishedStall {
  eventHallId: string;
  stallId: string;
  /** The plan revision these rows were copied from. */
  publishedRevision: number;
  zoneId: string | null;
  islandNumber: string | null;
  stallNumber: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  cutCells: Array<[number, number]>;
  labelArea: number | null;
  scheme: StallScheme;
  categoryIds: string[];
  isPremium: boolean;
  isBlocked: boolean;
  isFnb: boolean;
  isBranding: boolean;
  isHorseshoe: boolean;
  isMarqueeAvailable: boolean;
  isRestrictedForOverseas: boolean;
  isActive: boolean;
  location: string | null;
  description: string | null;
  /** ₹ set on the stall itself, as the plan has it. */
  price: number | null;
  /** `stallPrice()` at publish × 100, before GST; null when not for sale or unpriced. */
  pricePaise: number | null;
  currency: string | null;
  /** How the price was worked out, in words. */
  priceReckoning: string | null;
}
