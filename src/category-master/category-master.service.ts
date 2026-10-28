import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/domain/session-user';

/** Postgres: a row still referenced by another table. */
const FOREIGN_KEY_VIOLATION = '23503';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Real deletes of ITPO's code master: a category (`T_CODE_MASTER`) or a group of categories
 * (`T_CODE_TYPE`). ITPO's own delete only switches the row off, which the portal already has as
 * Deactivate; this removes it, and only when nothing uses it.
 */
@Injectable()
export class CategoryMasterService {
  constructor(
    private readonly db: DataSource,
    private readonly audit: AuditService,
  ) {}

  async deleteCategory(id: number, user: SessionUser): Promise<void> {
    const [category] = await this.db.query<Array<{ id: number; name: string }>>(
      `SELECT id, name FROM idp."T_CODE_MASTER" WHERE id = $1`,
      [id],
    );
    if (!category) throw new NotFoundException('That category does not exist.');

    const [halls] = await this.db.query<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM idp."T_HALL_CATEGORY_MAPPING" WHERE product_category_id = $1`,
      [id],
    );
    const [stalls] = await this.db.query<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM idp."T_STALLS" WHERE $1 = ANY(category_id)`,
      [id],
    );
    const uses = [
      halls.n ? plural(halls.n, 'hall', 'halls') : null,
      stalls.n ? plural(stalls.n, 'stall', 'stalls') : null,
    ].filter(Boolean);
    if (uses.length) {
      throw new ConflictException(
        `"${category.name}" is used by ${uses.join(' and ')}, so it cannot be deleted. Deactivate it instead.`,
      );
    }

    await this.remove(
      `DELETE FROM idp."T_CODE_MASTER" WHERE id = $1`,
      id,
      `"${category.name}" is still used elsewhere, so it cannot be deleted. Deactivate it instead.`,
    );
    await this.audit.record(user, {
      action: 'master.deleted',
      detail: `Category "${category.name}" deleted`,
    });
  }

  async deleteGroup(id: number, user: SessionUser): Promise<void> {
    const [group] = await this.db.query<Array<{ id: number; name: string; slug: string }>>(
      `SELECT id, name, slug FROM idp."T_CODE_TYPE" WHERE id = $1`,
      [id],
    );
    if (!group) throw new NotFoundException('That group does not exist.');

    const [categories] = await this.db.query<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM idp."T_CODE_MASTER" WHERE "typeId" = $1`,
      [id],
    );
    if (categories.n) {
      throw new ConflictException(
        `"${group.name}" still holds ${plural(categories.n, 'category', 'categories')}. Delete them first, or deactivate the group.`,
      );
    }
    const [events] = await this.db.query<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM idp."T_HALL_BOOKING" WHERE product_category = $1`,
      [group.slug],
    );
    if (events.n) {
      throw new ConflictException(
        `"${group.name}" is the category group of ${plural(events.n, 'event', 'events')}, so it cannot be deleted. Deactivate it instead.`,
      );
    }

    await this.remove(
      `DELETE FROM idp."T_CODE_TYPE" WHERE id = $1`,
      id,
      `"${group.name}" is still used elsewhere, so it cannot be deleted. Deactivate it instead.`,
    );
    await this.audit.record(user, {
      action: 'master.deleted',
      detail: `Group "${group.name}" deleted`,
    });
  }

  /** Deletes the row; a table the portal does not know that still points at it says no for us. */
  private async remove(sql: string, id: number, usedMessage: string): Promise<void> {
    try {
      await this.db.query(sql, [id]);
    } catch (error) {
      if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw new ConflictException(usedMessage);
      }
      throw error;
    }
  }
}
