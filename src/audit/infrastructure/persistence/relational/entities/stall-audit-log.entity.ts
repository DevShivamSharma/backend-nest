import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * Who changed what and when in the stall planning portal (plans saved, sent, approved...; rules
 * edited). Rows are only added. The event and hall are kept by id and by name, so a row still
 * reads right after ITPO renames or removes them. ITPO staff read it.
 */
@Entity({ name: 'T_STALL_AUDIT_LOG', schema: 'idp' })
export class StallAuditLogEntity extends EntityRelationalHelper {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_STALL_AUDIT_AT')
  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;

  @Index('IDX_STALL_AUDIT_ACTOR')
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 200, nullable: true })
  actorName: string | null;

  @Column({ name: 'actor_email', type: 'varchar', length: 200, nullable: true })
  actorEmail: string | null;

  @Column({ name: 'actor_type', type: 'varchar', length: 20, nullable: true })
  actorType: string | null;

  @Column({ type: 'varchar', length: 40 })
  action: string;

  @Index('IDX_STALL_AUDIT_EVENT')
  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'event_name', type: 'varchar', length: 300, nullable: true })
  eventName: string | null;

  @Column({ name: 'event_hall_id', type: 'uuid', nullable: true })
  eventHallId: string | null;

  @Column({ name: 'hall_name', type: 'varchar', length: 300, nullable: true })
  hallName: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  detail: string | null;
}
