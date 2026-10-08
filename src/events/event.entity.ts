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

import { OrganisationEntity } from '../organisations/organisation.entity';
import type { EventType } from '../rules/rule-catalogue';
import { HallEntity } from '../venues/hall.entity';
import { VenueEntity } from '../venues/venue.entity';

/** `internal`: the venue's own event. `external`: a third party organises it in the halls. */
export type EventKind = 'internal' | 'external';
export const EVENT_KINDS: readonly EventKind[] = ['internal', 'external'];

/**
 * Where an event is in its life. Stalls can be booked only while it is `scheduled`; a
 * cancelled event no longer reserves its halls.
 */
export type EventStatus = 'draft' | 'scheduled' | 'completed' | 'cancelled';
export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'scheduled',
  'completed',
  'cancelled',
];

/** An event of an organisation, at one of its venues, on a range of whole days. */
@Entity({ name: 'events' })
export class EventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 16 })
  kind!: EventKind;

  /** B2B or B2C, as the rules use it (passage widths differ). */
  @Column({ name: 'event_type', type: 'varchar', length: 8 })
  eventType!: EventType;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: EventStatus;

  /** First and last day, `YYYY-MM-DD`; both included. */
  @Column({ name: 'starts_on', type: 'date' })
  startsOn!: string;

  @Column({ name: 'ends_on', type: 'date' })
  endsOn!: string;

  @Column({ name: 'organiser_name', type: 'varchar', length: 160, nullable: true })
  organiserName!: string | null;

  @Column({ name: 'organiser_email', type: 'varchar', length: 254, nullable: true })
  organiserEmail!: string | null;

  @Column({ name: 'organiser_phone', type: 'varchar', length: 32, nullable: true })
  organiserPhone!: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  description!: string | null;

  @Column({ name: 'cancelled_reason', type: 'varchar', length: 500, nullable: true })
  cancelledReason!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;

  @ManyToOne(() => VenueEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'venue_id' })
  venue?: VenueEntity;
}

/**
 * A hall an event books, on the floor version it was booked with: a later floor version of the
 * hall does not move the event's stalls.
 */
@Entity({ name: 'event_halls' })
export class EventHallEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @PrimaryColumn({ name: 'hall_id', type: 'uuid' })
  hallId!: string;

  @Column({ name: 'floor_version', type: 'integer' })
  floorVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => EventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @ManyToOne(() => HallEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'hall_id' })
  hall?: HallEntity;
}
