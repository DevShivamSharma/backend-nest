import { Column, Entity, PrimaryColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/** A rule an event switched off or on for itself. An event without a row follows the hall and the default. */
@Entity({ name: 'T_EVENT_RULE_SWITCH', schema: 'idp' })
export class EventRuleSwitchEntity extends EntityRelationalHelper {
  /** T_HALL_BOOKING.id (ITPO's table, so no foreign key). */
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @PrimaryColumn({ name: 'rule_id', type: 'varchar', length: 40 })
  ruleId: string;

  @Column({ type: 'boolean' })
  enabled: boolean;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy: string;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
