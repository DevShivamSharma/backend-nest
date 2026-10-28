import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';

/**
 * The proof an ITPO reviewer attaches when sending an external event's hall plan back (images and
 * PDF, 5 MB each). Kept with the plan's event hall (T_EVENT_HALL.id, ITPO's table, so no foreign
 * key) and the revision that was rejected; a new round of review replaces them.
 */
@Entity({ name: 'T_STALL_PLAN_ATTACHMENT', schema: 'idp' })
export class StallPlanAttachmentEntity extends EntityRelationalHelper {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_STALL_PLAN_ATTACHMENT_HALL')
  @Column({ name: 'event_hall_id', type: 'uuid' })
  eventHallId: string;

  @Column({ type: 'integer' })
  revision: number;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ type: 'integer' })
  size: number;

  @Column({ type: 'bytea' })
  data: Buffer;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
