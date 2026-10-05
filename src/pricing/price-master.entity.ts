import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { PricePolicy } from './pricing-policy';

@Entity({ name: 'price_masters' })
export class PriceMasterEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'BY DEFAULT' }) id!: number;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  @Column({ type: 'integer', default: 1 }) revision!: number;
  @Column({ type: 'jsonb' }) policy!: PricePolicy;
}
