import { Column, Entity, PrimaryColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * A hall's own rule switch, on top of the default rule set: ITPO staff switch a rule off or on for
 * one hall (T_HALLS.id, ITPO's table, so no foreign key). A hall without a row follows the default;
 * an event's own switches come after these.
 */
@Entity({ name: 'T_HALL_RULE_SWITCH', schema: 'idp' })
export class HallRuleSwitchEntity extends EntityRelationalHelper {
  @PrimaryColumn({ name: 'hall_id', type: 'integer' })
  hallId: number;

  @PrimaryColumn({ name: 'rule_id', type: 'varchar', length: 40 })
  ruleId: string;

  @Column({ type: 'boolean' })
  enabled: boolean;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy: string;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
