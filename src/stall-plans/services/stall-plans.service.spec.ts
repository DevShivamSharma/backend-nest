import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { DEFAULT_RULE_VALUES, RULE_IDS, RuleSwitches } from '../../rules/domain/rule-catalogue';
import { itpoRowToFloor } from '../domain/itpo-hall-layout';
import { PlanContextService, PlanEventHall } from './plan-context.service';
import { StallPlansService } from './stall-plans.service';

const floor = itpoRowToFloor({
  layoutId: null,
  hallId: '1',
  name: 'Hall',
  length: 60,
  breadth: 60,
  layoutData: { nonClickableAreas: [] },
  legends: null,
  helperText: null,
  exitLabels: null,
  direction: null,
  defaultStalls: null,
}).floor;

const staff: SessionUser = {
  id: 'u-staff',
  email: 's@itpo.test',
  name: 'Staff',
  type: UserType.ItpoStaff,
  roles: [],
  orgId: null,
  organisationName: null,
};
const organiser: SessionUser = { ...staff, id: 'u-org', type: UserType.Organiser, orgId: 'org-1' };

const EVENT_HALL = 'a3b8a183-5aa9-40d7-9b38-f3f917d09421';

const hallOf = (patch: Partial<PlanEventHall> = {}): PlanEventHall => ({
  eventId: '9b198d87-eb1c-45e9-97fd-c49b7e7c604c',
  eventName: 'Fair',
  kind: 'internal',
  audience: 'B2B',
  approvalStatus: 'Approved',
  cancelled: false,
  orgId: 'org-1',
  organiserName: 'Org',
  eventHallId: EVENT_HALL,
  hallId: 74,
  hallName: 'Hall 74',
  hallCode: null,
  ...patch,
});

interface Plan {
  revision: number;
  stalls?: unknown[];
  /** Rows `T_STALLS` already has for the event hall. */
  existing?: Array<Record<string, unknown>>;
  review_status?: 'submitted' | 'approved' | 'rejected' | null;
  review_revision?: number | null;
  published_revision?: number | null;
  attachments?: Array<Record<string, unknown>>;
}

function build(hall: PlanEventHall, plan: Plan | null = { revision: 0 }) {
  const writes: { sql: string; params: unknown[] }[] = [];
  const row = (): Record<string, unknown> | null =>
    plan && {
      event_hall_id: EVENT_HALL,
      revision: plan.revision,
      content: { zones: [], stalls: plan.stalls ?? [], seats: [], objects: [] },
      review_status: plan.review_status ?? null,
      review_revision: plan.review_revision ?? null,
      submitted_at: plan.review_status ? new Date() : null,
      reviewed_at: null,
      review_note: null,
      published_revision: plan.published_revision ?? null,
      published_at: null,
      updated_at: new Date(),
    };
  const em = {
    query: (sql: string, params: unknown[] = []) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });
      if (/FROM idp\."T_EVENT_HALL"\s+WHERE booking_id/.test(sql))
        return Promise.resolve([{ id: EVENT_HALL }]);
      if (/FROM idp\."T_STALL_PLAN_ATTACHMENT"/.test(sql))
        return Promise.resolve(plan?.attachments ?? []);
      if (/count\(\*\) AS n/.test(sql)) return Promise.resolve([{ n: '3' }]);
      if (/FROM idp\."T_STALLS"\s+WHERE\s+\(event_hall_id/.test(sql) && !/^\s*UPDATE/i.test(sql))
        return Promise.resolve(plan?.existing ?? []);
      if (/SELECT \* FROM idp\."T_STALL_PLAN"/.test(sql))
        return Promise.resolve(plan ? [row()] : []);
      return Promise.resolve([]);
    },
  };
  const db = {
    manager: em,
    query: em.query,
    transaction: (fn: (e: unknown) => unknown) => fn(em),
  } as unknown as DataSource;
  const notify = {
    submitted: jest.fn(),
    withdrawn: jest.fn(),
    approved: jest.fn(),
    rejected: jest.fn(),
    reopened: jest.fn(),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const switches: RuleSwitches = Object.fromEntries(RULE_IDS.map((id) => [id, true]));
  const context = {
    eventHall: () => Promise.resolve(hall),
    rulesOf: () =>
      Promise.resolve({
        floor,
        switches,
        values: DEFAULT_RULE_VALUES,
        eventType: 'B2B' as const,
        drawingProfile: 'free',
      }),
    categories: () => Promise.resolve([{ id: '85', name: 'Food' }]),
  } as unknown as PlanContextService;
  return {
    service: new StallPlansService(db, context, audit as never, notify as never),
    writes,
    audit,
  };
}

const stall = (x: number, y: number, number: string, categoryIds: string[] = []) => ({
  id: randomUUID(),
  zoneId: null,
  islandNumber: null,
  stallNumber: number,
  x,
  y,
  width: 3,
  depth: 3,
  openSides: ['top'],
  cutCells: [],
  labelArea: null,
  price: null as number | null,
  scheme: 'shell',
  categoryIds,
  isPremium: false,
  isBlocked: false,
  isFnb: false,
  isBranding: false,
  isHorseshoe: false,
  isMarqueeAvailable: false,
  isRestrictedForOverseas: false,
  isActive: true,
  location: null,
  description: null,
});

const plan = (stalls: unknown[], revision = 0) =>
  ({ zones: [], seats: [], objects: [], stalls, revision }) as never;

describe('StallPlansService', () => {
  it('should save a plan that keeps the rules, and count the save', async () => {
    const { service, writes } = build(hallOf());

    await service.save(
      hallOf().eventId,
      EVENT_HALL,
      plan([stall(10, 10, '1'), stall(30, 10, '2')]),
      staff,
    );

    const update = writes.find((w) => /UPDATE idp\."T_STALL_PLAN"/.test(w.sql))!;
    expect(update.sql).toContain('revision = revision + 1');
    expect(JSON.parse(update.params[1] as string).stalls).toHaveLength(2);
  });

  it('should refuse a plan whose stalls overlap, and write nothing', async () => {
    const { service, writes } = build(hallOf());

    await expect(
      service.save(
        hallOf().eventId,
        EVENT_HALL,
        plan([stall(10, 10, '1'), stall(10.5, 10.5, '2')]),
        staff,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(writes.filter((w) => /T_STALL_PLAN/.test(w.sql) && /UPDATE/.test(w.sql))).toHaveLength(
      0,
    );
  });

  it('should refuse a plan with two stalls of the same number, or a category the hall does not sell', async () => {
    const { service } = build(hallOf());

    await expect(
      service.save(
        hallOf().eventId,
        EVENT_HALL,
        plan([stall(10, 10, '1'), stall(30, 10, '1')]),
        staff,
      ),
    ).rejects.toThrow(/numbered 1/);
    await expect(
      service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1', ['999'])]), staff),
    ).rejects.toThrow(/does not sell/);
  });

  it('should refuse a save made on an older revision', async () => {
    const { service } = build(hallOf(), { revision: 3 });

    await expect(
      service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1')], 2), staff),
    ).rejects.toThrow(ConflictException);
  });

  it('should keep an organiser out of an internal event, and ITPO staff out of an external one', async () => {
    const internal = build(hallOf());
    await expect(
      internal.service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1')]), organiser),
    ).rejects.toThrow(ForbiddenException);

    const external = build(hallOf({ kind: 'external' }));
    await expect(
      external.service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1')]), staff),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should let an organiser plan an external event only once it is approved', async () => {
    const pending = build(hallOf({ kind: 'external', approvalStatus: 'Pending' }));
    await expect(
      pending.service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1')]), organiser),
    ).rejects.toThrow(/approves the event/);

    const approved = build(hallOf({ kind: 'external' }));
    await expect(
      approved.service.save(hallOf().eventId, EVENT_HALL, plan([stall(10, 10, '1')]), organiser),
    ).resolves.toBeDefined();
  });

  it('should not publish an external plan until ITPO approved that revision', async () => {
    const { service } = build(hallOf({ kind: 'external' }), { revision: 2 });

    await expect(
      service.publish(hallOf().eventId, EVENT_HALL, { revision: 2 } as never, organiser),
    ).rejects.toThrow(/not approved/);
  });

  it('should not publish before the first save', async () => {
    const { service } = build(hallOf(), { revision: 0 });

    await expect(
      service.publish(hallOf().eventId, EVENT_HALL, { revision: 0 } as never, staff),
    ).rejects.toThrow(/Save the plan/);
  });

  it('should send an external plan for approval, and let ITPO staff approve what was sent', async () => {
    const hall = hallOf({ kind: 'external' });
    const sent = build(hall, { revision: 2 });
    await sent.service.submit(hall.eventId, EVENT_HALL, { revision: 2 } as never, organiser);
    expect(sent.writes.some((w) => /review_status = 'submitted'/.test(w.sql))).toBe(true);

    const waiting = build(hall, { revision: 2, review_status: 'submitted', review_revision: 2 });
    await waiting.service.review(hall.eventId, EVENT_HALL, { revision: 2 } as never, true, staff);
    expect(waiting.writes.find((w) => /review_status = \$2/.test(w.sql))!.params[1]).toBe(
      'approved',
    );

    await expect(
      waiting.service.review(hall.eventId, EVENT_HALL, { revision: 2 } as never, true, organiser),
    ).rejects.toThrow(ForbiddenException);
  });

  describe('publishing to ITPO', () => {
    const approved = { review_status: 'approved' as const, review_revision: 2 };
    const planned = (...stalls: ReturnType<typeof stall>[]) => ({
      revision: 2,
      stalls,
      ...approved,
    });

    it('should write each stall of an approved plan to T_STALLS, with the cells ITPO draws', async () => {
      const a = stall(10, 10, '1');
      const hall = hallOf({ kind: 'external' });
      const { service, writes } = build(hall, planned(a));

      await service.publish(hall.eventId, EVENT_HALL, { revision: 2 } as never, organiser);

      const insert = writes.find((w) => /INSERT INTO idp\."T_STALLS"/.test(w.sql))!;
      expect(insert.params[0]).toBe(a.id);
      expect(insert.params).toContain(hall.eventId);
      expect(insert.params).toContain(EVENT_HALL);
      const grid = JSON.parse(insert.params[6] as string);
      expect(grid.stallCoords).toHaveLength(9);
      expect(writes.some((w) => /published_revision = revision/.test(w.sql))).toBe(true);
    });

    it('should write a price set on the stall to T_STALLS, and nothing for one the rate card prices', async () => {
      const own = { ...stall(10, 10, '1'), price: 125000.5 };
      const hall = hallOf({ kind: 'external' });
      const { service, writes } = build(hall, planned(own, stall(20, 20, '2')));

      await service.publish(hall.eventId, EVENT_HALL, { revision: 2 } as never, organiser);

      const inserts = writes.filter((w) => /INSERT INTO idp\."T_STALLS"/.test(w.sql));
      // The price is the 18th value, after the stall's location.
      expect(inserts.map((w) => w.params[17])).toEqual([125000.5, null]);
    });

    it('should not replace stalls ITPO already has for the hall on a first publish', async () => {
      const hall = hallOf({ kind: 'external' });
      const { service, writes } = build(hall, {
        ...planned(stall(10, 10, '1')),
        existing: [{ id: randomUUID(), is_active: true, booking_status: 'Available' }],
      });

      await expect(
        service.publish(hall.eventId, EVENT_HALL, { revision: 2 } as never, organiser),
      ).rejects.toThrow(/already has 1 stalls/);
      expect(writes.some((w) => /T_STALLS/.test(w.sql))).toBe(false);
    });

    it('should switch off a stall taken out of the plan, but refuse to remove a booked one', async () => {
      const a = stall(10, 10, '1');
      const gone = randomUUID();
      const old = (id: string, status: string) => ({
        id,
        is_active: true,
        booking_status: status,
        stall_number: '9',
        island_number: 'X',
        stall_coordinates: {},
        layout_grid: {},
      });
      const hall = hallOf({ kind: 'internal' });
      const ok = build(hall, {
        revision: 2,
        stalls: [a],
        published_revision: 1,
        existing: [old(gone, 'Available')],
      });
      await ok.service.publish(hall.eventId, EVENT_HALL, { revision: 2 } as never, staff);
      expect(ok.writes.some((w) => /SET is_active = false/.test(w.sql))).toBe(true);

      const booked = build(hall, {
        revision: 2,
        stalls: [a],
        published_revision: 1,
        existing: [old(gone, 'Booked')],
      });
      await expect(
        booked.service.publish(hall.eventId, EVENT_HALL, { revision: 2 } as never, staff),
      ).rejects.toThrow(ConflictException);
      expect(booked.writes.some((w) => /T_STALLS/.test(w.sql))).toBe(false);
    });
  });

  describe('the approval of a hall', () => {
    const file = { originalname: 'proof.pdf', buffer: Buffer.from('%PDF-1.7 x') };
    const proofRow = (name: string) => ({
      name,
      mimeType: 'application/pdf',
      size: 10,
      data: Buffer.from('%PDF-1.7 x'),
    });

    it('should keep the proof of a rejection with the plan, and clear the last round first', async () => {
      const hall = hallOf({ kind: 'external' });
      const { service, writes } = build(hall, {
        revision: 2,
        review_status: 'submitted',
        review_revision: 2,
      });

      await service.review(
        hall.eventId,
        EVENT_HALL,
        { revision: 2, note: 'Aisle too narrow' },
        false,
        staff,
        [proofRow('proof.pdf')],
      );

      const kinds = writes
        .filter((w) => !/ON CONFLICT/.test(w.sql))
        .map((w) => w.sql.trim().split(/\s+/).slice(0, 3).join(' '));
      expect(kinds).toEqual([
        'UPDATE idp."T_STALL_PLAN" SET',
        'DELETE FROM idp."T_STALL_PLAN_ATTACHMENT"',
        'INSERT INTO idp."T_STALL_PLAN_ATTACHMENT"',
      ]);
      expect(writes.filter((w) => !/ON CONFLICT/.test(w.sql))[2].params).toEqual([
        EVENT_HALL,
        2,
        'proof.pdf',
        'application/pdf',
        10,
        expect.any(Buffer),
        staff.id,
      ]);
      void file;
    });

    it('should drop the proof when the plan is approved, and when it is sent again', async () => {
      const hall = hallOf({ kind: 'external' });
      const approve = build(hall, { revision: 2, review_status: 'submitted', review_revision: 2 });
      await approve.service.review(hall.eventId, EVENT_HALL, { revision: 2 }, true, staff, [
        proofRow('x.pdf'),
      ]);
      expect(
        approve.writes.some((w) => /INSERT INTO idp\."T_STALL_PLAN_ATTACHMENT"/.test(w.sql)),
      ).toBe(false);
      expect(
        approve.writes.some((w) => /DELETE FROM idp\."T_STALL_PLAN_ATTACHMENT"/.test(w.sql)),
      ).toBe(true);

      const again = build(hall, { revision: 2, review_status: 'rejected', review_revision: 2 });
      await again.service.submit(hall.eventId, EVENT_HALL, { revision: 2 } as never, organiser);
      expect(
        again.writes.some((w) => /DELETE FROM idp\."T_STALL_PLAN_ATTACHMENT"/.test(w.sql)),
      ).toBe(true);
    });

    it('should show the proof of a rejection when the plan is opened', async () => {
      const hall = hallOf({ kind: 'external' });
      const { service } = build(hall, {
        revision: 2,
        review_status: 'rejected',
        review_revision: 2,
        attachments: [{ id: 'f1', file_name: 'proof.pdf', mime_type: 'application/pdf', size: 10 }],
      });

      const view = await service.get(hall.eventId, EVENT_HALL, organiser);

      expect(view.plan.review?.attachments).toEqual([
        { id: 'f1', name: 'proof.pdf', mimeType: 'application/pdf', size: 10 },
      ]);
    });

    it('should let ITPO reopen an approved hall to Draft, and no one else, and nothing that is not approved', async () => {
      const hall = hallOf({ kind: 'external' });
      const approved = { revision: 2, review_status: 'approved' as const, review_revision: 2 };
      const ok = build(hall, approved);
      await ok.service.reopen(hall.eventId, EVENT_HALL, staff);
      expect(ok.writes.find((w) => /SET review_status = NULL/.test(w.sql))?.sql).toMatch(
        /SET review_status = NULL/,
      );

      await expect(
        build(hall, approved).service.reopen(hall.eventId, EVENT_HALL, organiser),
      ).rejects.toThrow('ITPO’s team reopens');
      await expect(
        build(hall, { revision: 2, review_status: 'submitted', review_revision: 2 }).service.reopen(
          hall.eventId,
          EVENT_HALL,
          staff,
        ),
      ).rejects.toThrow('Only an approved plan');
    });

    it('should tell, per hall, where the plan stands and what the user may do', async () => {
      const hall = hallOf({ kind: 'external' });
      const pending = await build(hall, {
        revision: 2,
        review_status: 'submitted',
        review_revision: 2,
      }).service.statuses(hall.eventId, staff);
      expect(pending[0]).toMatchObject({
        eventHallId: EVENT_HALL,
        status: 'pending',
        canApprove: true,
        canReopen: false,
      });

      const approved = await build(hall, {
        revision: 2,
        review_status: 'approved',
        review_revision: 2,
      }).service.statuses(hall.eventId, staff);
      expect(approved[0]).toMatchObject({ status: 'approved', canReopen: true });

      const draft = await build(hall, { revision: 1 }).service.statuses(hall.eventId, organiser);
      expect(draft[0]).toMatchObject({ status: 'draft', canSubmit: true, violations: 0 });

      const none = await build(hall, { revision: 0 }).service.statuses(hall.eventId, organiser);
      expect(none[0].status).toBe('not_started');
      const internal = await build(hallOf(), { revision: 3 }).service.statuses(hall.eventId, staff);
      expect(internal[0].status).toBe('planned');
    });

    it('should count the plans waiting for ITPO, for staff only', async () => {
      const { service } = build(hallOf({ kind: 'external' }));
      expect(await service.pendingCount(staff)).toBe(3);
      expect(await service.pendingCount(organiser)).toBe(0);
    });
  });
});
