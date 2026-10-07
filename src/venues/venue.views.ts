import type { ExternalSystem } from '../integrations/external-ref.entity';
import type { FloorCounts, HallFloor } from './floor/hall-floor';
import type { FloorSource, HallUses } from './hall.entity';

export interface VenueView {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  hallCount: number;
  createdAt: string;
}

/** The record of a venue system this hall stands for, e.g. ITPO's hall 56. */
export interface HallSourceView {
  system: ExternalSystem;
  externalId: string;
}

export interface HallView {
  id: string;
  venueId: string;
  name: string;
  code: string | null;
  level: string | null;
  uses: HallUses;
  width: number;
  depth: number;
  floorArea: number;
  currentVersion: number;
  source: HallSourceView | null;
  updatedAt: string;
}

export interface FloorVersionView {
  version: number;
  source: FloorSource;
  sourceRef: string | null;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  current: boolean;
}

export interface HallDetailView extends HallView {
  venue: { id: string; name: string };
  floor: HallFloor;
  versions: FloorVersionView[];
}

/** What importing one ITPO hall would do, before anything is saved. */
export interface ItpoImportRowView {
  externalId: string;
  layoutId: string | null;
  /** SelfCare's name for it when the file has one, else a suggestion. */
  name: string;
  width: number | null;
  depth: number | null;
  floorArea: number | null;
  counts: FloorCounts | null;
  labels: number;
  iconGroups: number;
  warnings: string[];
  /** The hall an earlier import made from it; importing again adds a floor version. */
  existing: {
    hallId: string;
    name: string;
    venueId: string;
    venueName: string;
    sameFloor: boolean;
  } | null;
  /** Why this row cannot be imported. */
  error: string | null;
}

export interface ItpoImportPreview {
  rows: ItpoImportRowView[];
}

export interface ItpoImportResult {
  created: HallView[];
  updated: HallView[];
  unchanged: HallView[];
}
