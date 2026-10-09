import type { CategoryStatus } from './category.entity';

export interface CategoryView {
  id: string;
  name: string;
  status: CategoryStatus;
  /** Event halls that sell it; such a category can be switched off but not deleted. */
  eventHalls: number;
  updatedAt: string;
}

/** A category as an event hall or a stall shows it. */
export interface CategoryRef {
  id: string;
  name: string;
  status: CategoryStatus;
}

export interface CategoryImportView {
  created: number;
  /** Rows not added, with why: already listed, or twice in the file. */
  skipped: Array<{ name: string; reason: string }>;
}
