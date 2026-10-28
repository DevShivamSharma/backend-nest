import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';
import { EmailRecipientListEntity } from './email-recipient-list.entity';

/** One person on a list. The address is kept in lower case, so a list holds it once. */
@Entity({ name: 'T_EMAIL_RECIPIENT', schema: 'idp' })
@Index('UQ_EMAIL_RECIPIENT_LIST_EMAIL', ['listSlug', 'email'], { unique: true })
export class EmailRecipientEntity extends EntityRelationalHelper {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'list_slug', type: 'varchar', length: 60 })
  listSlug: string;

  @ManyToOne(() => EmailRecipientListEntity, (list) => list.people, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'list_slug', referencedColumnName: 'slug' })
  list?: EmailRecipientListEntity;

  @Column({ type: 'varchar', length: 254 })
  email: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
