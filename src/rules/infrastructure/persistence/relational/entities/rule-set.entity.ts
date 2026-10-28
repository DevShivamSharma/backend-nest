import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * The planning rules: one set, applied to every hall. A single row (id 1), made by the migration
 * with the standard rules: no switches stored (a missing switch is on) and no values stored (the
 * defaults apply).
 */
@Entity({ name: 'T_RULE_SET', schema: 'idp' })
@Check('"id" = 1')
export class RuleSetEntity extends EntityRelationalHelper {
  @PrimaryColumn({ type: 'smallint' })
  id: number;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  switches: Record<string, boolean>;

  @Column({ name: 'rule_values', type: 'jsonb', default: () => `'{}'::jsonb` })
  ruleValues: Record<string, unknown>;

  @Column({ name: 'doc_references', type: 'jsonb', default: () => `'[]'::jsonb` })
  docReferences: unknown[];

  @Column({ name: 'drawing_profile', type: 'varchar', length: 40, default: 'free' })
  drawingProfile: string;

  /** The T_USER who last changed it; ITPO's table, so no foreign key. */
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
