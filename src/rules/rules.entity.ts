import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { RuleSwitches, RuleValues } from './rule-catalogue';

/** A document the rules follow, e.g. ITPO's safety guidelines of September 2022. */
export interface RuleReference {
  document: string;
  section?: string | null;
  note?: string | null;
}

/**
 * An organisation's rules: which of the fixed checks are on, with which values, the documents
 * they come from, and the drawing profile of the venue's system.
 *
 * One per organisation: the row marked default. The table was first made for several named
 * sets; `name` and `is_default` remain from that and are filled in by the service.
 */
@Entity({ name: 'rule_sets' })
export class OrganisationRulesEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ type: 'jsonb', default: {} })
  switches!: RuleSwitches;

  /** Stored partial; read through `effectiveValues`. */
  @Column({ name: 'rule_values', type: 'jsonb', default: {} })
  values!: Partial<RuleValues>;

  @Column({ name: 'doc_references', type: 'jsonb', default: [] })
  references!: RuleReference[];

  @Column({ name: 'drawing_profile', type: 'varchar', length: 40, default: 'free' })
  drawingProfile!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
