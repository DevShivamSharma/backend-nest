import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { EventHallCategoryEntity, StallCategoryEntity } from './category.entity';
import type { CategoryImportView, CategoryView } from './categories.views';
import { CreateCategoryDto, ImportCategoriesDto, UpdateCategoryDto } from './dto/categories.dto';

/**
 * The organisation's master list of stall categories. The Venue Admin keeps it; event halls
 * pick from its active entries, and stalls from their hall's.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async list(organisationId: string): Promise<CategoryView[]> {
    const rows = await this.dataSource
      .getRepository(StallCategoryEntity)
      .createQueryBuilder('c')
      .leftJoin(EventHallCategoryEntity, 'ehc', 'ehc.category_id = c.id')
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .addSelect('c.status', 'status')
      .addSelect('c.updated_at', 'updatedAt')
      .addSelect('COUNT(ehc.event_hall_id)::int', 'eventHalls')
      .where('c.organisation_id = :organisationId', { organisationId })
      .groupBy('c.id')
      .orderBy('lower(c.name)', 'ASC')
      .getRawMany<Omit<CategoryView, 'updatedAt'> & { updatedAt: Date }>();
    return rows.map((r) => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString() }));
  }

  async create(
    organisationId: string,
    dto: CreateCategoryDto,
    actor: Actor,
  ): Promise<CategoryView> {
    const saved = await this.dataSource.transaction(async (em) => {
      await this.assertNameFree(em, organisationId, dto.name);
      const repo = em.getRepository(StallCategoryEntity);
      const category = await repo.save(
        repo.create({ organisationId, name: dto.name, status: dto.status ?? 'active' }),
      );
      await this.record(em, 'category.created', organisationId, category, actor, {
        status: category.status,
      });
      return category;
    });
    return CategoriesService.view(saved, 0);
  }

  async update(
    organisationId: string,
    id: string,
    dto: UpdateCategoryDto,
    actor: Actor,
  ): Promise<CategoryView> {
    await this.dataSource.transaction(async (em) => {
      const category = await this.category(em, organisationId, id);
      const changed: string[] = [];
      if (dto.name !== undefined && dto.name !== category.name) {
        await this.assertNameFree(em, organisationId, dto.name, category.id);
        changed.push('name');
        category.name = dto.name;
      }
      if (dto.status !== undefined && dto.status !== category.status) {
        changed.push('status');
        category.status = dto.status;
      }
      if (!changed.length) return;
      await em.getRepository(StallCategoryEntity).save(category);
      await this.record(em, 'category.updated', organisationId, category, actor, {
        changed,
        status: category.status,
      });
    });
    return (await this.list(organisationId)).find((c) => c.id === id)!;
  }

  /** Only a category nothing uses; one in use is switched off instead. */
  async remove(organisationId: string, id: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const category = await this.category(em, organisationId, id);
      const halls = await em.getRepository(EventHallCategoryEntity).countBy({ categoryId: id });
      if (halls) {
        throw new ConflictException(
          `${category.name} is sold on ${halls} event ${halls === 1 ? 'hall' : 'halls'}. Make it inactive instead.`,
        );
      }
      await em.getRepository(StallCategoryEntity).delete({ id });
      await this.record(em, 'category.deleted', organisationId, category, actor, {});
    });
  }

  /** Adds the rows whose names are new; names already listed, or repeated, are skipped. */
  async import(
    organisationId: string,
    dto: ImportCategoriesDto,
    actor: Actor,
  ): Promise<CategoryImportView> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StallCategoryEntity);
      const existing = await repo.findBy({ organisationId });
      const taken = new Set(existing.map((c) => c.name.toLowerCase()));
      const skipped: CategoryImportView['skipped'] = [];
      const fresh: StallCategoryEntity[] = [];
      for (const row of dto.rows) {
        const key = row.name.toLowerCase();
        if (taken.has(key)) {
          const known = existing.some((c) => c.name.toLowerCase() === key);
          skipped.push({ name: row.name, reason: known ? 'Already listed' : 'Twice in the file' });
          continue;
        }
        taken.add(key);
        fresh.push(repo.create({ organisationId, name: row.name, status: row.status ?? 'active' }));
      }
      if (fresh.length) await repo.save(fresh);
      await this.audit.record(
        {
          action: 'category.imported',
          actor,
          organisationId,
          targetType: 'category',
          metadata: { created: fresh.length, skipped: skipped.length },
        },
        em,
      );
      return { created: fresh.length, skipped };
    });
  }

  private async category(
    em: EntityManager,
    organisationId: string,
    id: string,
  ): Promise<StallCategoryEntity> {
    const category = await em
      .getRepository(StallCategoryEntity)
      .findOne({ where: { id, organisationId }, lock: { mode: 'pessimistic_write' } });
    if (!category) throw new NotFoundException('There is no such category.');
    return category;
  }

  private async assertNameFree(
    em: EntityManager,
    organisationId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(StallCategoryEntity)
      .createQueryBuilder('c')
      .where('c.organisation_id = :organisationId', { organisationId })
      .andWhere('lower(c.name) = lower(:name)', { name })
      .getOne();
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(`There is already a category called ${clash.name}.`);
    }
  }

  private record(
    em: EntityManager,
    action: string,
    organisationId: string,
    category: StallCategoryEntity,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor,
        organisationId,
        targetType: 'category',
        targetId: category.id,
        metadata: { name: category.name, ...metadata },
      },
      em,
    );
  }

  static view(c: StallCategoryEntity, eventHalls: number): CategoryView {
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      eventHalls,
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
