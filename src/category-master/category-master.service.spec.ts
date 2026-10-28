import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/domain/session-user';
import { UserType } from '../auth/domain/user-type';
import { CategoryMasterService } from './category-master.service';

const staff: SessionUser = {
  id: 's1',
  email: '',
  name: '',
  type: UserType.ItpoStaff,
  roles: [],
  orgId: null,
  organisationName: null,
};

interface World {
  category?: { id: number; name: string };
  group?: { id: number; name: string; slug: string };
  halls?: number;
  stalls?: number;
  categoriesInGroup?: number;
  events?: number;
  deleteFails?: boolean;
}

function build(world: World) {
  const deletes: string[] = [];
  const query = jest.fn(async (sql: string) => {
    const q = sql.replace(/\s+/g, ' ');
    if (q.startsWith('SELECT id, name FROM idp."T_CODE_MASTER"'))
      return world.category ? [world.category] : [];
    if (q.includes('FROM idp."T_HALL_CATEGORY_MAPPING"')) return [{ n: world.halls ?? 0 }];
    if (q.includes('FROM idp."T_STALLS"')) return [{ n: world.stalls ?? 0 }];
    if (q.startsWith('SELECT id, name, slug FROM idp."T_CODE_TYPE"'))
      return world.group ? [world.group] : [];
    if (q.includes('FROM idp."T_CODE_MASTER" WHERE "typeId"'))
      return [{ n: world.categoriesInGroup ?? 0 }];
    if (q.includes('FROM idp."T_HALL_BOOKING"')) return [{ n: world.events ?? 0 }];
    if (q.startsWith('DELETE')) {
      if (world.deleteFails) throw Object.assign(new Error('fk'), { code: '23503' });
      deletes.push(q);
      return [];
    }
    throw new Error(`Unexpected: ${q}`);
  });
  const audit = { record: jest.fn(async () => undefined) };
  const service = new CategoryMasterService(
    { query } as unknown as DataSource,
    audit as unknown as AuditService,
  );
  return { service, deletes, audit };
}

describe('CategoryMasterService', () => {
  it('should delete a category nothing uses, and record it', async () => {
    const { service, deletes, audit } = build({ category: { id: 7, name: 'Fruits' } });

    await service.deleteCategory(7, staff);

    expect(deletes).toEqual(['DELETE FROM idp."T_CODE_MASTER" WHERE id = $1']);
    expect(audit.record).toHaveBeenCalledWith(
      staff,
      expect.objectContaining({ action: 'master.deleted' }),
    );
  });

  it('should keep a category that halls or stalls use, and say which', async () => {
    const { service, deletes } = build({
      category: { id: 7, name: 'Fruits' },
      halls: 2,
      stalls: 1,
    });

    await expect(service.deleteCategory(7, staff)).rejects.toThrow(/2 halls and 1 stall/);
    expect(deletes).toEqual([]);
  });

  it('should keep a category another table still points at', async () => {
    const { service } = build({ category: { id: 7, name: 'Fruits' }, deleteFails: true });

    await expect(service.deleteCategory(7, staff)).rejects.toBeInstanceOf(ConflictException);
  });

  it('should say so when the category or the group is not there', async () => {
    const { service } = build({});

    await expect(service.deleteCategory(1, staff)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteGroup(1, staff)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('should delete an empty group no event uses', async () => {
    const { service, deletes } = build({ group: { id: 3, name: 'AAHAR', slug: 'aahar' } });

    await service.deleteGroup(3, staff);

    expect(deletes).toEqual(['DELETE FROM idp."T_CODE_TYPE" WHERE id = $1']);
  });

  it('should keep a group that holds categories or that an event uses', async () => {
    const full = build({ group: { id: 3, name: 'AAHAR', slug: 'aahar' }, categoriesInGroup: 4 });
    await expect(full.service.deleteGroup(3, staff)).rejects.toThrow(/4 categories/);

    const used = build({ group: { id: 3, name: 'AAHAR', slug: 'aahar' }, events: 1 });
    await expect(used.service.deleteGroup(3, staff)).rejects.toThrow(/1 event/);
    expect(used.deletes).toEqual([]);
  });
});
