import type { SelfcareBookingPayload } from '../selfcare-booking';

/**
 * Response shapes. Field names and nesting reproduce what Jackson produced from the Java
 * entities and DTOs (docs/02-api-inventory.md section 0).
 */
export interface HallResponse {
  planningZones: unknown[] | null;
  id: number;
  name: string | null;
  shape: string | null;
  width: number | null;
  length: number | null;
  radius: number | null;
  blockedAreas: unknown[] | null;
  boundary: unknown[] | null;
  zones: unknown[] | null;
  openings: unknown[] | null;
  markers: unknown[] | null;
  amenities: unknown[] | null;
  compass: Record<string, unknown> | null;
  legends: unknown[] | null;
  rules: Record<string, unknown> | null;
}

export interface StallResponse {
  /** Custom (polygon) stall outline; absent for a rectangle. */
  footprint?: Array<{ x: number; z: number }>;
  openEdges?: number[];
  rotation: number;
  parentStallNumber: string | null;
  isSplitParent: boolean;
  id: number;
  name: string | null;
  width: number;
  length: number;
  height: number;
  posX: number;
  posZ: number;
  color: string | null;
  gateSide: string | null;
  openSides: string[] | null;
  stallNumber: string | null;
  status: string;
  stallTypeId: string | null;
}

export interface LayoutResponse {
  pricingPolicy?: import('../../pricing/pricing-policy').PricingSnapshot;
  status: 'DRAFT' | 'PUBLISHED';
  publishedAt: string | null;
  publishOverrides: import('../entities/layout.entity').LayoutEntity['publishOverrides'];
  id: number;
  name: string;
  hallWidth: number;
  hallLength: number;
  hallHeight: number;
  eventType: string;
  /** Plotting rules chosen for this layout; empty when none. */
  ruleIds: number[];
  hall: HallResponse | null;
  stalls: StallResponse[];
}

/**
 * LayoutDetail.java. The hall and stalls appear twice — inside `layout` and at the top level.
 * That redundancy is part of the contract (ADR-009): the frontends read the top-level
 * `hall` / `stalls` and `layout.id` / `layout.name`.
 */
export interface LayoutDetailResponse {
  message: string | null;
  layout: LayoutResponse;
  hall: HallResponse | null;
  stalls: StallResponse[];
}

/**
 * POST /api/layout/{id}/stalls/{stallNumber}/book: the stall as booked, and the same booking as
 * rows for the SelfCare portal's tables (see selfcare-booking.ts).
 */
export interface StallBookedResponse {
  quote?: import('../../pricing/pricing-policy').StallQuote;
  message: string;
  layoutId: number;
  stall: StallResponse;
  selfcare: SelfcareBookingPayload;
}

/** LayoutSummary.java (record). */
export interface LayoutSummaryResponse {
  status?: 'DRAFT' | 'PUBLISHED';
  publishedAt?: string | null;
  id: number;
  name: string;
  hallId: number | null;
  hallName: string | null;
  shape: string | null;
  hallWidth: number;
  hallLength: number;
  radius: number | null;
  stallCount: number;
}

/** POST /api/layout/{id}/validate: every rule problem in the saved layout. Never blocks. */
export interface LayoutAuditResponse {
  layoutId: number;
  ruleDriven: boolean;
  valid: boolean;
  entries: unknown[];
}

export interface LayoutDeletedResponse {
  message: string;
  id: number;
}
