import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** An organisation's link to its venue system: where a published plan is pushed, and how it is signed. */
@Entity({ name: 'venue_system_integrations' })
export class VenueSystemIntegrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'callback_url', type: 'varchar', length: 500 })
  callbackUrl!: string;

  /** The shared HMAC secret, sealed (`common/sealed-secret.ts`). Never returned, never logged. */
  @Column({ name: 'secret_sealed', type: 'text' })
  secretSealed!: string;

  /** The secret's last four characters, to tell which one is set. */
  @Column({ name: 'secret_hint', type: 'varchar', length: 8 })
  secretHint!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdById!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
