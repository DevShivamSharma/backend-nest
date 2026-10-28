import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { EntityRelationalHelper } from '../../../../../utils/relational-entity-helper';
import { EmailRecipientEntity } from './email-recipient.entity';

/**
 * A list of people an email goes to, named by the slug the code asks for. A `system` list is one
 * the portal itself sends to: it can be switched off or filled, never deleted.
 */
@Entity({ name: 'T_EMAIL_RECIPIENT_LIST', schema: 'idp' })
export class EmailRecipientListEntity extends EntityRelationalHelper {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: false })
  system: boolean;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => EmailRecipientEntity, (person) => person.list)
  people?: EmailRecipientEntity[];
}
