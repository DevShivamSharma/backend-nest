/** Data-only types of the main-branch CAD analysis engine; no legacy database entities. */
export interface Point {
  x: number;
  z: number;
}
export interface BlockedArea {
  posX: number;
  posZ: number;
  width: number;
  length: number;
  kind: 'outside' | 'wall' | 'zone';
  color: string;
  strokeColor?: string;
  title?: string;
  hidden?: boolean;
}
export interface HallAmenity {
  kind: string;
  label: string;
  position: Point;
  anchor?: Point | null;
  slot?: number | null;
}
export interface HallCompass {
  position: Point;
  size: number;
  rotation: number;
  label: string;
  labelOffset: Point;
}
export interface HallLegend {
  label: string;
  colorCode?: string | null;
  htmlContent?: string | null;
  visibleInViewMode?: boolean;
  visibleInBookMode?: boolean;
}
export interface HallMarker {
  text: string;
  position: Point;
}
export type ZoneKind =
  | 'PASSAGE'
  | 'NO_CONSTRUCTION'
  | 'EMERGENCY_EXIT_ACCESS'
  | 'ENTRY_EXIT_ACCESS'
  | 'FACILITY_ACCESS'
  | 'FOYER'
  | 'PARTITION'
  | 'SMOKE_CURTAIN';
export interface HallZone {
  id: string;
  kind: ZoneKind;
  label: string;
  polygon: Point[];
  clearance?: number | null;
  color?: string | null;
  hidden?: boolean | null;
}
export type OpeningFacing = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';
export interface HallOpening {
  id: string;
  label: string;
  kind: 'ENTRY' | 'EXIT' | 'SERVICE' | 'EMERGENCY';
  position: Point;
  width: number;
  facing: OpeningFacing;
}
