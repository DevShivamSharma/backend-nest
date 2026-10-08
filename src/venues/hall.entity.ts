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
import { UserEntity } from '../users/user.entity';
import type { HallFloor } from './floor/hall-floor';
import { VenueEntity } from './venue.entity';

/** What a hall may be booked for, besides exhibition stalls. */
export interface HallUses {
  fnb?: boolean;
  branding?: boolean;
  horseshoe?: boolean;
  openArea?: boolean;
}

/**
 * A hall of a venue. Its floor lives in {@link HallFloorVersionEntity}; the size and floor area
 * here are copied from the current version, so lists need no floor.
 */
@Entity({ name: 'halls' })
export class HallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  code!: string | null;

  /** Floor of the building, as the venue names it: "Ground", "First". */
  @Column({ type: 'varchar', length: 40, nullable: true })
  level!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  uses!: HallUses;

  @Column({ type: 'double precision' })
  width!: number;

  @Column({ type: 'double precision' })
  depth!: number;

  @Column({ name: 'floor_area', type: 'double precision' })
  floorArea!: number;

  @Column({ name: 'current_version', type: 'integer' })
  currentVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => OrganisationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: OrganisationEntity;

  @ManyToOne(() => VenueEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'venue_id' })
  venue?: VenueEntity;
}

/** Where a floor version came from. */
export type FloorSource = 'blank' | 'itpo' | 'restore' | 'drawing' | 'json' | 'csv';

/** One saved state of a hall's floor. Rows are never updated. */
@Entity({ name: 'hall_floor_versions' })
export class HallFloorVersionEntity {
  @PrimaryColumn({ name: 'hall_id', type: 'uuid' })
  hallId!: string;

  @PrimaryColumn({ type: 'integer' })
  version!: number;

  @Column({ type: 'jsonb' })
  floor!: HallFloor;

  @Column({ type: 'varchar', length: 16 })
  source!: FloorSource;

  /** Which record it came from, e.g. "ITPO hall 56, layout row 20". */
  @Column({ name: 'source_ref', type: 'varchar', length: 200, nullable: true })
  sourceRef!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => HallEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hall_id' })
  hall?: HallEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  createdBy?: UserEntity | null;
}
