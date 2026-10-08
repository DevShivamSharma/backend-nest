import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { PlanPage } from './plan.types';

/** Durable review documents. Shared foyers belong here, and saved halls reference their IDs. */
@Entity({ name: 'floor_plan_imports' })
export class FloorPlanImportEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organisation_id', type: 'uuid' }) organisationId!: string;
  @Column({ name: 'venue_id', type: 'uuid' }) venueId!: string;
  @Column({ name: 'file_name', type: 'varchar', length: 200 }) fileName!: string;
  @Column({ name: 'file_hash', type: 'varchar', length: 64 }) fileHash!: string;
  @Column({ name: 'reader_version', type: 'varchar', length: 40, default: 'legacy' })
  readerVersion!: string;
  @Column({ type: 'varchar', length: 16 }) status!: 'reading' | 'ready' | 'failed';
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'integer', default: 1 }) revision!: number;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) pages!: PlanPage[];
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) committed!: Record<string, string>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
