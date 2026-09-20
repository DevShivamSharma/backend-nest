/**
 * Response shapes. Field names and nesting reproduce what Jackson produced from the Java
 * entities and DTOs (docs/02-api-inventory.md section 0).
 */
export interface HallResponse {
  id: number;
  name: string | null;
  shape: string | null;
  width: number | null;
  length: number | null;
  radius: number | null;
  blockedAreas: unknown[] | null;
}

export interface StallResponse {
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
}

export interface LayoutResponse {
  id: number;
  name: string;
  hallWidth: number;
  hallLength: number;
  hallHeight: number;
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

/** LayoutSummary.java (record). */
export interface LayoutSummaryResponse {
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

export interface LayoutDeletedResponse {
  message: string;
  id: number;
}
