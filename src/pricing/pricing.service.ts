import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PriceMasterEntity } from './price-master.entity';
import { quoteStall, validateMaster } from './pricing-policy';
import { LayoutEntity } from '../layouts/entities/layout.entity';
import { LayoutRepository } from '../layouts/layout.repository';
import { stallArea, openSideCount } from '../layouts/layout.service';

@Injectable()
export class PricingService {
  constructor(private readonly db: DataSource, private readonly layouts: LayoutRepository) {}
  list(): Promise<PriceMasterEntity[]> { return this.db.getRepository(PriceMasterEntity).find({ order: { name: 'ASC' } }); }
  async library() {
    const rows = await this.db.query('SELECT catalog, imported_at FROM pricing_libraries WHERE id = $1', ['p-db-demo']);
    return rows[0] ? { ...rows[0].catalog, importedAt: rows[0].imported_at } : null;
  }
  async create(value: unknown): Promise<PriceMasterEntity> { return (await this.importRows([value]))[0]; }
  async importRows(rows: unknown): Promise<PriceMasterEntity[]> {
    if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new BadRequestException('Import 1–500 price masters.');
    const validated = rows.map((row, i) => {
      try { return validateMaster(row); } catch (e) { throw new BadRequestException(`Row ${i + 2}: ${(e as Error).message}`); }
    });
    const names = validated.map(r => r.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BadRequestException('Duplicate names in the import. Give each master a unique name.');
    try {
      return await this.db.transaction(async m => m.save(validated.map(({ name, ...policy }) => m.create(PriceMasterEntity, { name, policy }))));
    } catch (e) { this.rethrow(e); }
  }
  async update(id: number, body: { revision?: number; master?: unknown }): Promise<PriceMasterEntity> {
    const { name, ...policy } = validateMaster(body?.master);
    try {
      return await this.db.transaction(async m => {
        const row = await m.findOne(PriceMasterEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!row) throw new NotFoundException('Price master not found.');
        if (row.revision !== body?.revision) throw new ConflictException('This price master changed. Reload it before saving.');
        Object.assign(row, { name, policy, revision: row.revision + 1 });
        return m.save(row);
      });
    } catch (e) { this.rethrow(e); }
  }
  async assign(id: number, body: { masterId?: number; revision?: number }) {
    if (!Number.isSafeInteger(body?.masterId) || body.masterId! < 1) throw new BadRequestException('Choose a price master.');
    return this.db.transaction(async m => {
      const layout = await m.findOne(LayoutEntity, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!layout) throw new NotFoundException('Layout not found.');
      const master = await m.findOne(PriceMasterEntity, { where: { id: body.masterId }, lock: { mode: 'pessimistic_read' } });
      if (!master) throw new NotFoundException('Price master not found.');
      if (master.revision !== body.revision) throw new ConflictException('Rates changed. Reload the price master before applying it.');
      layout.pricingPolicy = { masterId: master.id, name: master.name, revision: master.revision, policy: master.policy };
      layout.status = 'DRAFT'; layout.publishedAt = null; layout.publishOverrides = null;
      await m.save(layout);
      return { pricingPolicy: layout.pricingPolicy, status: layout.status };
    });
  }
  async quote(id: number, number: string, type: unknown) {
    const detail = await this.layouts.findById(id);
    if (!detail) throw new NotFoundException('Layout not found.');
    const stall = detail.stalls.find(s => s.stallNumber === number && !s.isSplitParent && s.status !== 'CANCELLED');
    if (!stall) throw new NotFoundException('Stall not found.');
    if (stall.bookingQuote) return stall.bookingQuote;
    if (!detail.layout.pricingPolicy) throw new BadRequestException('No price master is assigned to this layout.');
    return quoteStall(detail.layout.pricingPolicy, id, number, stallArea(stall), openSideCount(stall), type);
  }
  private rethrow(e: unknown): never {
    if ((e as { code?: string }).code === '23505') throw new ConflictException('A price master with this name already exists. Nothing was imported.');
    throw e;
  }
}
