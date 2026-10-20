import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { ExternalRefEntity } from '../integrations/external-ref.entity';
import { setExternalId } from '../integrations/external-refs';
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
      .leftJoin(
        ExternalRefEntity,
        'ref',
        "ref.local_id = c.id AND ref.organisation_id = c.organisation_id AND ref.system = 'itpo' AND ref.entity_type = 'category'",
      )
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .addSelect('c.status', 'status')
      .addSelect('c.updated_at', 'updatedAt')
      .addSelect('COUNT(ehc.event_hall_id)::int', 'eventHalls')
      .addSelect('ref.external_id', 'itpoId')
      .where('c.organisation_id = :organisationId', { organisationId })
      .groupBy('c.id')
      .addGroupBy('ref.external_id')
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
      if (dto.itpoId !== undefined) {
        await setExternalId(
          em,
          { organisationId, system: 'itpo', entityType: 'category', localId: category.id },
          dto.itpoId,
        );
      }
      await this.record(em, 'category.created', organisationId, category, actor, {
        status: category.status,
      });
      return category;
    });
    return CategoriesService.view(saved, 0, dto.itpoId ?? null);
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
      if (
        dto.itpoId !== undefined &&
        (await setExternalId(
          em,
          { organisationId, system: 'itpo', entityType: 'category', localId: category.id },
          dto.itpoId,
        ))
      ) {
        changed.push('itpoId');
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
      await em.getRepository(ExternalRefEntity).delete({ organisationId, localId: id });
      await em.getRepository(StallCategoryEntity).delete({ id });
      await this.record(em, 'category.deleted', organisationId, category, actor, {});
    });
  }

  /**
   * Adds the rows whose names are new; names already listed, or repeated, are skipped. A row
   * with a SelfCare id (an export of `T_CODE_MASTER`) keeps the two lists in step instead: the
   * category linked to that id takes the row's name and status, else one of the same name not
   * yet linked is linked to it, else it is added, linked. SelfCare's ids never change, so the
   * same file can be imported again whenever SelfCare's list changes.
   */
  async import(
    organisationId: string,
    dto: ImportCategoriesDto,
    actor: Actor,
  ): Promise<CategoryImportView> {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(StallCategoryEntity);
      const existing = await repo.findBy({ organisationId });
      const refs = await em
        .getRepository(ExternalRefEntity)
        .findBy({ organisationId, system: 'itpo', entityType: 'category' });
      const byItpo = new Map(
        refs.flatMap((r) => {
          const c = existing.find((e) => e.id === r.localId);
          return c ? [[r.externalId, c] as const] : [];
        }),
      );
      const linked = new Set(refs.map((r) => r.localId));
      /** Lower-cased name → the category that holds it, as the import goes. */
      const names = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      const skipped: CategoryImportView['skipped'] = [];
      let created = 0;
      let updated = 0;
      let linkedNow = 0;
      for (const row of dto.rows) {
        const key = row.name.toLowerCase();
        const status = row.status ?? 'active';
        if (seenNames.has(key) || (row.itpoId && seenIds.has(row.itpoId))) {
          skipped.push({ name: row.name, reason: 'Twice in the file' });
          continue;
        }
        seenNames.add(key);
        if (!row.itpoId) {
          if (names.has(key)) {
            skipped.push({ name: row.name, reason: 'Already listed' });
            continue;
          }
          const saved = await repo.save(repo.create({ organisationId, name: row.name, status }));
          names.set(key, saved);
          created++;
          continue;
        }
        seenIds.add(row.itpoId);
        const ref = { organisationId, system: 'itpo' as const, entityType: 'category' as const };
        const own = byItpo.get(row.itpoId);
        const holder = names.get(key);
        if (own) {
          if (holder && holder.id !== own.id) {
            skipped.push({ name: row.name, reason: `Another category is called ${holder.name}` });
            continue;
          }
          if (own.name === row.name && own.status === status) continue;
          names.delete(own.name.toLowerCase());
          own.name = row.name;
          own.status = status;
          names.set(key, await repo.save(own));
          updated++;
        } else if (holder) {
          if (linked.has(holder.id)) {
            skipped.push({ name: row.name, reason: 'Linked to another SelfCare id' });
            continue;
          }
          await setExternalId(em, { ...ref, localId: holder.id }, row.itpoId);
          linked.add(holder.id);
          if (holder.status !== status) {
            holder.status = status;
            await repo.save(holder);
          }
          linkedNow++;
        } else {
          const saved = await repo.save(repo.create({ organisationId, name: row.name, status }));
          await setExternalId(em, { ...ref, localId: saved.id }, row.itpoId);
          linked.add(saved.id);
          names.set(key, saved);
          created++;
        }
      }
      await this.audit.record(
        {
          action: 'category.imported',
          actor,
          organisationId,
          targetType: 'category',
          metadata: { created, updated, linked: linkedNow, skipped: skipped.length },
        },
        em,
      );
      return { created, updated, linked: linkedNow, skipped };
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

  static view(c: StallCategoryEntity, eventHalls: number, itpoId: string | null): CategoryView {
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      eventHalls,
      itpoId,
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
