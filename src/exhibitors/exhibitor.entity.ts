import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { EventEntity } from '../events/event.entity';
import { OrganisationEntity } from '../organisations/organisation.entity';

/**
 * A company that takes stalls at an organisation's events. Its people sign in with the
 * event-scoped exhibitor role, whose membership scope names this exhibitor.
 */
@Entity({ name: 'exhibitors' })
export class ExhibitorEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 120, nullable: true })
  contactName!: string | null;

  @Column({ type: 'varchar', length: 254, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 15, nullable: true })
  gstin!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;
}

/** An exhibitor taking part in an event: only these can hold or book its stalls. */
@Entity({ name: 'event_exhibitors' })
export class EventExhibitorEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @PrimaryColumn({ name: 'exhibitor_id', type: 'uuid' })
  exhibitorId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => EventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @ManyToOne(() => ExhibitorEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'exhibitor_id' })
  exhibitor?: ExhibitorEntity;
}
