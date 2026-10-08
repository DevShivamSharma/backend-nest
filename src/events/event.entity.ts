import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { EventType, RuleSwitches, RuleValues } from '../rules/rule-catalogue';
import { HallEntity } from '../venues/hall.entity';

/** Internal: the venue runs it. External: an organiser booked the halls. */
export const EVENT_KINDS = ['internal', 'external'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** An event of the organisation, on some of its halls, for some dates. Dates are `YYYY-MM-DD`. */
@Entity({ name: 'events' })
export class EventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: EventKind;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** The event's id in the venue's own system, e.g. ITPO's hall booking. */
  @Column({ name: 'venue_event_id', type: 'varchar', length: 80, nullable: true })
  venueEventId!: string | null;

  /** The company that booked the halls; external events only. */
  @Column({ name: 'organiser_name', type: 'varchar', length: 160, nullable: true })
  organiserName!: string | null;

  /** Sets the passage width the rules ask for. */
  @Column({ type: 'varchar', length: 8 })
  audience!: EventType;

  @Column({ name: 'starts_on', type: 'date' })
  startsOn!: string;

  @Column({ name: 'ends_on', type: 'date' })
  endsOn!: string;

  /** Build-up starts (mounting); on or before the start. */
  @Column({ name: 'build_up_on', type: 'date', nullable: true })
  buildUpOn!: string | null;

  /** Dismantling ends; on or after the end. */
  @Column({ name: 'dismantle_on', type: 'date', nullable: true })
  dismantleOn!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * A hall of an event: the floor version it is drawn on, kept even when the hall's floor
 * changes later, and the rules that apply to it, copied from the organisation's rules when the
 * hall was added and then switched for this event.
 */
@Entity({ name: 'event_halls' })
export class EventHallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'hall_id', type: 'uuid' })
  hallId!: string;

  @Column({ name: 'floor_version', type: 'integer' })
  floorVersion!: number;

  @Column({ name: 'rule_switches', type: 'jsonb', default: {} })
  ruleSwitches!: RuleSwitches;

  @Column({ name: 'rule_values', type: 'jsonb', default: {} })
  ruleValues!: Partial<RuleValues>;

  @Column({ name: 'drawing_profile', type: 'varchar', length: 40, default: 'free' })
  drawingProfile!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => EventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @ManyToOne(() => HallEntity)
  @JoinColumn({ name: 'hall_id' })
  hall?: HallEntity;
}
