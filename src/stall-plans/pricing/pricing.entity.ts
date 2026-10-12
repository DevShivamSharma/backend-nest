import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { PriceType } from './stall-price';

/** Postgres numeric comes back as text; prices are used as numbers. */
const money = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/** One price type's rates on an event hall's rate card. */
@Entity({ name: 'stall_price_cards' })
export class StallPriceCardEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: PriceType;

  @Column({ name: 'bare_rate', type: 'numeric', precision: 12, scale: 2, transformer: money })
  bareRate!: number;

  @Column({ name: 'shell_rate', type: 'numeric', precision: 12, scale: 2, transformer: money })
  shellRate!: number;

  @Column({ name: 'side2_percent', type: 'numeric', precision: 6, scale: 2, transformer: money })
  side2Percent!: number;

  @Column({ name: 'side3_percent', type: 'numeric', precision: 6, scale: 2, transformer: money })
  side3Percent!: number;

  @Column({ name: 'side4_percent', type: 'numeric', precision: 6, scale: 2, transformer: money })
  side4Percent!: number;

  @Column({
    name: 'catalogue_charge',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: money,
  })
  catalogueCharge!: number;

  @Column({
    name: 'fnb_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: money,
  })
  fnbPrice!: number | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * A price set on one stall of an event hall's plan, before the rate card. Kept by stall id
 * apart from the plan, which is saved whole, so a price outlives the saves that keep its stall.
 */
@Entity({ name: 'stall_prices' })
export class StallPriceEntity {
  @PrimaryColumn({ name: 'event_hall_id', type: 'uuid' })
  eventHallId!: string;

  @PrimaryColumn({ name: 'stall_id', type: 'uuid' })
  stallId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: money })
  price!: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedById!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
