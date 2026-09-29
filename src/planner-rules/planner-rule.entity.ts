import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Table `planner_rules`: one stall-plotting rule, written as free text by a planner. Rules are
 * a shared library, not tied to halls; a layout records the ones chosen for it (`rule_ids`).
 */
@Entity({ name: 'planner_rules' })
export class PlannerRuleEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'BY DEFAULT' })
  id!: number;

  @Column({ type: 'text' })
  description!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
