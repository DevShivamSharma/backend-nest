import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuditService } from '../../audit/audit.service';
import type { OrgAccessContext } from '../../common/http/authenticated-request';
import type { EventsService } from '../../events/events.service';
import type { RulesService } from '../../rules/rules.service';
import type { ItpoHallImportService } from '../../venues/itpo-hall-import.service';
import { ItpoEventsService } from './itpo-events.service';

describe('ItpoEventsService', () => {
  const EVENT = '11111111-1111-4111-8111-111111111111';
  const actor = { id: 'u1', email: 'a@itpo.test' };

  function access(organiser: boolean): OrgAccessContext {
    return {
      organisation: { id: 'org' },
      membership: {
        id: 'm',
        scope: {},
        role: { scopeKind: organiser ? 'event' : 'organisation' },
      },
      permissions: ['events.view', 'events.manage'],
    } as unknown as OrgAccessContext;
  }

  function service(booking: Record<string, unknown> | null, itpoOrgId = 'org-a') {
    const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
      if (sql.includes('FROM idp."T_HALL_BOOKING"')) return booking ? [booking] : [];
      return [];
    });
    const dataSource = {
      query,
      transaction: jest.fn(async (fn: (em: unknown) => unknown) => fn({ query })),
      getRepository: () => ({
        findOneBy: async () => ({ id: 'u1', itpoOrgId }),
        findBy: async () => [],
      }),
    } as unknown as DataSource;
    const svc = new ItpoEventsService(
      dataSource,
      {} as ItpoHallImportService,
      {} as EventsService,
      {} as RulesService,
      { record: jest.fn() } as unknown as AuditService,
    );
    return { svc, query };
  }

  const row = (more: Record<string, unknown> = {}) => ({
    id: EVENT,
    code: 'H-1',
    name: 'Expo',
    kind: null,
    orgId: 'org-a',
    halls: 2,
    ...more,
  });

  it('reads B2C off the booking when the public comes, else B2B', () => {
    expect(ItpoEventsService.audience('B2C event')).toBe('B2C');
    expect(ItpoEventsService.audience('B2B & B2C both')).toBe('B2C');
    expect(ItpoEventsService.audience('B2B')).toBe('B2B');
    expect(ItpoEventsService.audience(null)).toBe('B2B');
  });

  it("keeps internal events from organisers, and shows them only their organisation's", async () => {
    const { svc, query } = service(row());
    await expect(svc.list(access(true), actor, 'internal', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await svc.list(access(true), actor, 'external', 'expo');
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('T_HALL_BOOKING'))!;
    expect(sql).toContain('hb.org_id = $2');
    expect(params).toEqual([['Cancelled', 'Rejected'], 'org-a', '%expo%']);
  });

  it("does not find another organisation's event for an organiser", async () => {
    const { svc } = service(row({ orgId: 'org-b' }));
    await expect(svc.get(access(true), actor, EVENT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adds halls to internal events only, and only for ITPO', async () => {
    await expect(
      service(row({ kind: 'internal' })).svc.addHall(access(true), actor, EVENT, '64', false),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service(row()).svc.addHall(access(false), actor, EVENT, '64', false),
    ).rejects.toThrow('Halls are added to internal events here');
  });

  it('adds a hall as SelfCare does: the event hall, and its F&B categories', async () => {
    const { svc, query } = service(row({ kind: 'internal' }));
    query.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM idp."T_HALL_BOOKING"')) return [row({ kind: 'internal' })];
      if (sql.includes('FROM idp."T_HALLS" h')) return [{ id: 64, name: 'Hall 11' }];
      if (sql.includes('INSERT INTO idp."T_EVENT_HALL"')) return [{ id: 'eh-1' }];
      return [];
    });
    jest.spyOn(svc, 'open').mockResolvedValue({ eventId: 'ours' });
    jest.spyOn(svc, 'get').mockResolvedValue({} as never);
    await svc.addHall(access(false), actor, EVENT, '64', true);
    const sqls = query.mock.calls.map(([s]) => s as string);
    expect(sqls.some((s) => s.includes('INSERT INTO idp."T_EVENT_HALL"'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO idp."T_HALL_CATEGORY_MAPPING"'))).toBe(true);
  });
});
