/** All source geometry uses page coordinates (x right, y down). Saved floors use metres. */
export type Point = [number, number];
export type Polygon = Point[][];
export type MultiPolygon = Polygon[];
export type AreaKind =
  | 'outside'
  | 'wall'
  | 'column'
  | 'passage'
  | 'fire_curtain'
  | 'no_build'
  | 'utility'
  | 'entry'
  | 'unavailable'
  | 'void'
  | 'facility'
  | 'marking';
export interface Grid {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}
export interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source: 'vector' | 'ocr';
  confidence: number;
}
export interface Evidence {
  source: 'legend' | 'text' | 'geometry' | 'user';
  detail: string;
}
export interface PlanObject {
  id: string;
  kind: AreaKind | 'unknown';
  label: string;
  geometry: MultiPolygon;
  color: string;
  confirmed: boolean;
  evidence: Evidence;
}
export interface PlanRegion {
  id: string;
  name: string;
  role: 'hall' | 'foyer' | 'circulation' | 'exclude';
  geometry: MultiPolygon;
  hallIds: string[];
  confirmed: boolean;
  restrictionsConfirmed?: boolean;
  grid: Grid | null;
  printedArea: number | null;
}
export interface DimensionCheck {
  id: string;
  label: string;
  a: Point;
  b: Point;
  metres: number;
  regionId: string | null;
  confirmed: boolean;
}
export interface PlanAnnotation {
  id: string;
  type: 'facility' | 'label';
  text: string;
  kind: string | null;
  anchor: Point;
  regionIds: string[];
  confirmed: boolean;
  evidence: Evidence;
}
export interface PlanPage {
  number: number;
  width: number;
  height: number;
  format: 'pdf-vector' | 'pdf-scan' | 'image' | 'dxf';
  preview: string;
  texts: TextBox[];
  regions: PlanRegion[];
  objects: PlanObject[];
  calibration: { metresPerUnit: number | null; source: string; confirmed: boolean };
  grid: Grid | null;
  dimensions: DimensionCheck[];
  legend: { label: string; color: string | null }[];
  annotations?: PlanAnnotation[];
  warnings: string[];
}
export interface PlanCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  expected?: number;
  measured?: number;
  tolerance?: number;
  detail: string;
  blocking: boolean;
  overridable: boolean;
}
export interface PlanReview {
  key: string;
  page: number;
  regionId: string;
  name: string;
  width: number;
  depth: number;
  hallArea: number;
  foyerArea: number;
  drawableArea: number;
  checks: PlanCheck[];
  ready: boolean;
  savedHallId: string | null;
  existing: { id: string; name: string; version: number }[];
}
export interface PlanView {
  id: string;
  fileName: string;
  revision: number;
  status: 'reading' | 'ready' | 'failed';
  error: string | null;
  pages: PlanPage[];
  halls: PlanReview[];
  committed: Record<string, string>;
}
export interface GeometryObject {
  id: string;
  kind: AreaKind;
  label: string;
  geometry: MultiPolygon;
  color: string;
  blocksStalls: boolean;
  evidence: Evidence;
}
export interface FloorGeometry {
  schema: 'geometry/1';
  unit: 'm';
  boundary: MultiPolygon;
  hallBoundary: MultiPolygon;
  grid: Grid;
  objects: GeometryObject[];
  zones: {
    id: string;
    name: string;
    kind: 'foyer' | 'circulation';
    geometry: MultiPolygon;
    grid?: Grid;
    shared: boolean;
    hallKeys: string[];
  }[];
  source: {
    documentId: string;
    page: number;
    regionId: string;
    origin: Point;
    metresPerUnit: number;
  };
  review: { revision: number; checks: PlanCheck[]; acknowledgements: string[] };
}
export interface CommitSelection {
  key: string;
  name: string;
  targetHallId: string | null;
  expectedVersion: number | null;
  acknowledgements: string[];
}
export interface CommitResult {
  key: string;
  hallId?: string;
  version?: number;
  error?: string;
}
