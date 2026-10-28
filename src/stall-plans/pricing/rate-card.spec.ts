import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { cardAt, periodProblems, type RatePeriod } from './rate-card';
import { RateCardService } from './rate-card.service';

const period = (over: Partial<RatePeriod>): RatePeriod => ({
  type: 'General',
  startAt: '2027-01-01T00:00:00+05:30',
  endAt: '2027-01-31T23:59:59+05:30',
  bareRate: 10000,
  shellRate: 11000,
  side2Percent: 10,
  side3Percent: 15,
  side4Percent: 20,
  catalogueCharge: 0,
  fnbPrice: null,
  ...over,
});

describe('periodProblems', () => {
  it('should need General rates', () => {
    expect(periodProblems([period({ type: 'Premium' })])).toEqual([
      expect.stringContaining('Add the General rates'),
    ]);
  });

  it('should refuse a period that ends before it starts, and periods of one type that overlap', () => {
    const problems = periodProblems([
      period({ startAt: '2027-02-01T00:00:00+05:30', endAt: '2027-01-01T23:59:59+05:30' }),
      period({ startAt: '2027-03-01T00:00:00+05:30', endAt: '2027-03-31T23:59:59+05:30' }),
      period({ startAt: '2027-03-31T12:00:00+05:30', endAt: '2027-04-30T23:59:59+05:30' }),
      period({
        type: 'Premium',
        startAt: '2027-03-01T00:00:00+05:30',
        endAt: '2027-03-31T23:59:59+05:30',
      }),
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('ends before it starts');
    expect(problems[1]).toContain('overlap');
  });

  it('should let two periods of one type follow each other', () => {
    expect(
      periodProblems([
        period({ endAt: '2027-01-14T23:59:59+05:30' }),
        period({
          startAt: '2027-01-15T00:00:00+05:30',
          endAt: '2027-01-31T23:59:59+05:30',
          bareRate: 12000,
        }),
      ]),
    ).toEqual([]);
  });
});

describe('cardAt', () => {
  const early = period({ endAt: '2027-01-14T23:59:59+05:30', bareRate: 9000 });
  const late = period({ startAt: '2027-01-15T00:00:00+05:30', bareRate: 12000 });

  it('should take the period that includes the day, per price type', () => {
    const card = cardAt(
      [early, late, period({ type: 'Premium', bareRate: 20000 })],
      new Date('2027-01-20T10:00:00+05:30'),
    )!;
    expect(card.general.bareRate).toBe(12000);
    expect(card.premium?.bareRate).toBe(20000);
    expect(card.marquee).toBeNull();
  });

  it('should take the next period before the first, and the last one after the last', () => {
    expect(cardAt([early, late], new Date('2026-12-01T10:00:00+05:30'))!.general.bareRate).toBe(
      9000,
    );
    expect(cardAt([early, late], new Date('2028-01-01T10:00:00+05:30'))!.general.bareRate).toBe(
      12000,
    );
  });

  it('should be null without General', () => {
    expect(cardAt([period({ type: 'Marquee' })], new Date('2027-01-05T10:00:00+05:30'))).toBeNull();
  });
});

describe('RateCardService', () => {
  const ids = {
    one: '11111111-1111-4111-8111-111111111111',
    two: '22222222-2222-4222-8222-222222222222',
  };
  function build(opts: { canEdit?: boolean } = {}) {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const row = (id: string) => ({
      id,
      applicable_to: 'General',
      start_date: new Date('2026-12-31T18:30:00Z'),
      end_date: new Date('2027-12-31T18:29:59Z'),
      bare_rate: '10000.00',
      shell_rate: '11000.00',
      two_side_open_rate_percent: '10.00',
      three_side_open_rate_percent: null,
      four_side_open_rate_percent: '20.00',
      catlog_entry_charge: '0.00',
      fnb_price: null,
    });
    const em = {
      query: (sql: string, params: unknown[] = []) => {
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });
        if (/FROM idp\."T_STALL_PRICE_MASTER"/.test(sql))
          return Promise.resolve([row(ids.one), row(ids.two)]);
        return Promise.resolve([]);
      },
    };
    const db = { manager: em, transaction: (fn: (e: typeof em) => unknown) => fn(em) };
    const context = { eventHall: () => Promise.resolve({ eventName: 'Fair' }) };
    const plans = {
      editableHall: () =>
        opts.canEdit === false
          ? Promise.reject(new ForbiddenException('The plan is read-only.'))
          : Promise.resolve({ name: 'Hall 1', code: null }),
    };
    return {
      service: new RateCardService(
        db as never,
        context as never,
        plans as never,
        { record: () => Promise.resolve() } as never,
      ),
      writes,
    };
  }
  const dto = (periods: Array<Partial<RatePeriod>>) =>
    ({ periods: periods.map((p) => period(p)) }) as never;
  const user = {} as never;

  it('should give the periods as ITPO keeps them, and the rates of today', async () => {
    const view = await build().service.get('e', 'h', user);
    expect(view.periods[0]).toMatchObject({
      type: 'General',
      bareRate: 10000,
      side3Percent: 0,
      fnbPrice: null,
    });
    expect(view.canManage).toBe(true);
    expect(view.card?.general.side2Percent).toBe(10);
  });

  it('should tell a reader who may not change it', async () => {
    const view = await build({ canEdit: false }).service.get('e', 'h', user);
    expect(view).toMatchObject({ canManage: false, readOnlyReason: 'The plan is read-only.' });
  });

  it('should update the rows it keeps, delete the ones left out and insert the new ones', async () => {
    const { service, writes } = build();
    await service.save(
      'e',
      'h',
      dto([
        { id: ids.one },
        { startAt: '2027-02-01T00:00:00+05:30', endAt: '2027-02-28T23:59:59+05:30' },
      ]),
      user,
    );
    expect(writes.map((w) => w.sql.trim().split(/\s/)[0])).toEqual(['DELETE', 'UPDATE', 'INSERT']);
    expect(writes[0].params).toEqual([[ids.two]]);
  });

  it("should refuse unsound periods, a row that is not the hall's, and a reader, before writing", async () => {
    const { service, writes } = build();
    await expect(service.save('e', 'h', dto([{ type: 'Premium' }]), user)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.save('e', 'h', dto([{ id: '33333333-3333-4333-8333-333333333333' }]), user),
    ).rejects.toThrow('not found');
    await expect(build({ canEdit: false }).service.save('e', 'h', dto([{}]), user)).rejects.toThrow(
      ForbiddenException,
    );
    expect(writes).toEqual([]);
  });
});
