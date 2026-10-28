import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { DataSource } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import {
  AddEventHallsDto,
  CreateInternalEventDto,
  UpdateEventHallDto,
  UpdateInternalEventDto,
} from '../dto/events.dto';
import { EventsService } from './events.service';

const staff: SessionUser = {
  id: 'staff-1',
  email: '',
  name: '',
  type: UserType.ItpoStaff,
  roles: [],
  orgId: null,
  organisationName: null,
};
const ORG = '5b4bec0b-1a99-47bf-83d5-5b8af1412534';
const EVENT = '11111111-1111-4111-8111-111111111111';

interface World {
  trackerLatest?: string;
  internalEvent?: boolean;
  orgActive?: boolean;
  halls?: Record<
    number,
    { name: string; hall_code: string | null; hall_area_capacity: string | null }
  >;
  alreadyAdded?: number[];
  clash?: string;
  fnbCategories?: number[];
  /** The event as saved, for an edit. */
  event?: Record<string, unknown>;
  /** The event hall as saved, for an edit or a removal. */
  eventHall?: Record<string, unknown> | null;
  planned?: boolean;
  serviced?: boolean;
}

const SAVED_EVENT = {
  tenancy_period_start_date: new Date(2026, 10, 5),
  tenancy_period_end_date: new Date(2026, 10, 29),
  exhibition_period_from_date: null,
  exhibition_period_to_date: null,
};
const SAVED_HALL = {
  id: 'eh-64',
  hall_id: '64',
  hall_name: 'Hall 11',
  is_stall_fnb: false,
  is_nta_area_request: false,
  nta_pricing_type: null,
  mounting_period_from_date: null,
  mounting_period_to_date: null,
  exhibition_period_from_date: '2026-11-14',
  exhibition_period_to_date: '2026-11-27',
  dismantling_period_from_date: null,
  dismantling_period_to_date: null,
  stall_booking_start_date: null,
  stall_booking_end_date: null,
};

function build(world: World = {}) {
  const sql: { text: string; params: unknown[] }[] = [];
  const tx = {
    query: (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
      if (text.includes('FROM idp."T_ORGANIZATION"'))
        return Promise.resolve(world.orgActive === false ? [] : [{ name: 'ITPO' }]);
      if (text.includes('FROM idp."T_EVENT_BOOKING_ID_TRACKER"'))
        return Promise.resolve(world.trackerLatest ? [{ booking_id: world.trackerLatest }] : []);
      if (text.includes('INSERT INTO idp."T_EVENT_BOOKING_ID_TRACKER"')) return Promise.resolve([]);
      if (text.includes('INSERT INTO idp."T_HALL_BOOKING"'))
        return Promise.resolve([{ id: EVENT, visibility_status: false }]);
      if (text.includes('UPDATE idp."T_HALL_BOOKING"')) {
        // An UPDATE ... RETURNING answers as [rows, affected count].
        return Promise.resolve([
          [
            {
              booking_id: 'H-20261100001',
              event_name: 'IITF 2026',
              tenancy_period_start_date: new Date(2026, 10, 5),
              tenancy_period_end_date: new Date(2026, 10, 29),
              visibility_status: params.includes(true),
            },
          ],
          1,
        ]);
      }
      // An edit reads the event's saved dates; every other event lookup only needs it to exist.
      if (text.includes('tenancy_period_start_date,') && text.startsWith('SELECT'))
        return Promise.resolve(world.internalEvent === false ? [] : [world.event ?? SAVED_EVENT]);
      if (
        /FROM idp."T_HALL_BOOKING"\s+WHERE id = \$1 AND event_booking_type = 'internal'/.test(text)
      )
        return Promise.resolve(world.internalEvent === false ? [] : [{ id: EVENT }]);
      if (text.includes('FROM idp."T_HALLS"')) {
        const hall = world.halls?.[params[0] as number];
        return Promise.resolve(hall ? [hall] : []);
      }
      if (text.includes('SELECT 1 FROM idp."T_EVENT_HALL"'))
        return Promise.resolve(world.alreadyAdded?.includes(params[1] as number) ? [{}] : []);
      if (text.includes('JOIN idp."T_HALL_BOOKING" hb'))
        return Promise.resolve(world.clash ? [{ event_name: world.clash }] : []);
      if (text.includes('INSERT INTO idp."T_EVENT_HALL"'))
        return Promise.resolve([{ id: `eh-${params[1]}` }]);
      if (text.includes('FROM idp."T_EVENT_HALL" WHERE id = $1 AND booking_id = $2'))
        return Promise.resolve(world.eventHall === null ? [] : [world.eventHall ?? SAVED_HALL]);
      if (text.includes('UPDATE idp."T_EVENT_HALL"')) return Promise.resolve([[], 1]);
      if (text.includes('DELETE FROM idp."T_EVENT_HALL"')) return Promise.resolve([[], 1]);
      if (text.includes('"T_STALLS"')) return Promise.resolve(world.planned ? [{}] : []);
      if (text.includes('"T_HALL_SERVICES_DETAIL"'))
        return Promise.resolve(world.serviced ? [{}] : []);
      if (text.includes('DELETE FROM idp."T_HALL_CATEGORY_MAPPING"'))
        return Promise.resolve([[], 3]);
      if (text.includes('"T_CODE_TYPE"'))
        return Promise.resolve((world.fnbCategories ?? []).map((id) => ({ id })));
      if (text.includes('INSERT INTO idp."T_HALL_CATEGORY_MAPPING"')) return Promise.resolve([]);
      throw new Error(`unexpected query: ${text.slice(0, 70)}`);
    },
  };
  const db = { transaction: (fn: (t: unknown) => unknown) => fn(tx) } as unknown as DataSource;
  return { service: new EventsService(db), sql };
}

const updateDto = (input: Record<string, unknown>) =>
  plainToInstance(UpdateInternalEventDto, input);
const hallEditDto = (input: Record<string, unknown>) => plainToInstance(UpdateEventHallDto, input);
const eventDto = (input: Record<string, unknown>) => plainToInstance(CreateInternalEventDto, input);
const hallsDto = (halls: Record<string, unknown>[]) => plainToInstance(AddEventHallsDto, { halls });
const find = (sql: { text: string; params: unknown[] }[], part: string) =>
  sql.find((q) => q.text.includes(part))!;

const BASE = {
  organisationId: ORG,
  name: 'IITF 2026',
  startDate: '2026-11-05',
  endDate: '2026-11-29',
};
const HALLS = {
  64: { name: 'Hall 11', hall_code: 'H11', hall_area_capacity: '5730' },
  65: { name: 'Hall 12', hall_code: null, hall_area_capacity: '1880' },
  76: { name: 'F&B Outlet', hall_code: null, hall_area_capacity: '0' },
};

describe('CreateInternalEventDto', () => {
  it('needs only the organisation, a name and the tenancy dates', () => {
    expect(validateSync(eventDto(BASE))).toHaveLength(0);
  });

  it.each([
    ['no name', { organisationId: ORG, startDate: '2026-11-05', endDate: '2026-11-29' }],
    ['no organisation', { name: 'X', startDate: '2026-11-05', endDate: '2026-11-29' }],
    ['an organisation that is not an id', { ...BASE, organisationId: 'ITPO' }],
    ['blank name', { ...BASE, name: '  ' }],
    ['no dates', { organisationId: ORG, name: 'X' }],
    ['a date in the wrong shape', { ...BASE, startDate: '05/11/2026' }],
    ['an unknown event type', { ...BASE, eventType: 'B2G' }],
    ['a negative visitor count', { ...BASE, expectedNumberOfVisitor: -1 }],
    ['a name over 200 characters', { ...BASE, name: 'x'.repeat(201) }],
  ])('refuses %s', (_label, input) => {
    expect(validateSync(eventDto(input)).length).toBeGreaterThan(0);
  });

  it('accepts every optional field the user may give', () => {
    const full = {
      ...BASE,
      eventType: 'B2B',
      eventFormat: 'Exhibition',
      coOrganizerName: 'Co',
      description: 'd',
      productProfile: 'p',
      specificProductProfile: 'sp',
      productCategory: 'c',
      exhibitionStartDate: '2026-11-14',
      exhibitionEndDate: '2026-11-27',
      startTimeOfEvent: '10:00',
      endTimeOfEvent: '19:00',
      expectedNumberOfVisitor: 1000,
      expectedNumberOfExhibitors: 200,
      noOfStalls: 5,
      noOfFnbStalls: 1,
      maxCategoriesForRegistration: 2,
      specialRequest: 's',
      fileNumber: 'F-1',
      remarks: 'r',
      bannerImageId: 7,
      allowOverseasUser: true,
      isMarqueeEnabled: false,
      isSecondaryEnabled: false,
      visibilityStatus: true,
    };
    expect(validateSync(eventDto(full))).toHaveLength(0);
  });
});

describe('EventsService.createInternal', () => {
  it('books an internal event as approved and completed, under the organisation the staff member chose', async () => {
    const { service, sql } = build();

    const event = await service.createInternal(eventDto(BASE), staff);
    const insert = find(sql, 'INSERT INTO idp."T_HALL_BOOKING"');

    expect(event).toMatchObject({
      id: EVENT,
      bookingId: 'H-20261100001',
      name: 'IITF 2026',
      visibilityStatus: false,
    });
    expect(insert.text).toContain('event_booking_type');
    expect(insert.params).toEqual(
      expect.arrayContaining([
        'H-20261100001',
        'internal',
        'Completed',
        'Approved',
        'ITPO',
        ORG,
        'staff-1',
        'IITF 2026',
        '2026-11-05',
        '2026-11-29',
      ]),
    );
  });

  it('writes no invoice columns', async () => {
    const { service, sql } = build();
    await service.createInternal(eventDto(BASE), staff);

    expect(find(sql, 'INSERT INTO idp."T_HALL_BOOKING"').text).not.toMatch(
      /amount|subtotal|tds|gst|charge/,
    );
  });

  it('saves the optional fields the user gives, and only those', async () => {
    const { service, sql } = build();
    await service.createInternal(
      eventDto({
        ...BASE,
        description: 'The fair',
        expectedNumberOfVisitor: 500,
        visibilityStatus: true,
        allowOverseasUser: true,
      }),
      staff,
    );
    const insert = find(sql, 'INSERT INTO idp."T_HALL_BOOKING"');

    for (const column of [
      'event_desc',
      'expected_number_of_visitor',
      'visibility_status',
      'allow_overseas_user',
    ]) {
      expect(insert.text).toContain(column);
    }
    expect(insert.text).not.toContain('event_format');
    expect(insert.text).not.toContain('special_request');
  });

  it('carries the booking number on from the last of that month', async () => {
    const { service, sql } = build({ trackerLatest: 'H-20261100272' });

    const event = await service.createInternal(eventDto(BASE), staff);

    expect(event.bookingId).toBe('H-20261100273');
    expect(find(sql, 'INSERT INTO idp."T_EVENT_BOOKING_ID_TRACKER"').params).toEqual([
      'H-20261100273',
      'H',
      '202611',
    ]);
  });

  it('defaults the event type to B2B & B2C both', async () => {
    const { service, sql } = build();
    await service.createInternal(eventDto(BASE), staff);

    expect(find(sql, 'INSERT INTO idp."T_HALL_BOOKING"').params).toContain('B2B & B2C both');
  });

  it('refuses an event that ends before it starts, or a date that is not real', async () => {
    const { service } = build();

    await expect(
      service.createInternal(eventDto({ ...BASE, endDate: '2026-11-01' }), staff),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createInternal(eventDto({ ...BASE, startDate: '2026-02-30' }), staff),
    ).rejects.toThrow('not a real calendar date');
    await expect(
      service.createInternal(
        eventDto({ ...BASE, exhibitionStartDate: '2026-11-20', exhibitionEndDate: '2026-11-10' }),
        staff,
      ),
    ).rejects.toThrow('exhibition cannot end before');
  });

  it("uses the chosen organisation's name as the organiser", async () => {
    const { service, sql } = build();
    await service.createInternal(eventDto(BASE), staff);

    expect(find(sql, 'FROM idp."T_ORGANIZATION"').params).toEqual([ORG]);
    expect(find(sql, 'INSERT INTO idp."T_HALL_BOOKING"').params).toEqual(
      expect.arrayContaining(['ITPO', ORG]),
    );
  });

  it('refuses an organisation that does not exist or is not active', async () => {
    await expect(
      build({ orgActive: false }).service.createInternal(eventDto(BASE), staff),
    ).rejects.toThrow('Organisation not found.');
  });
});

describe('EventsService.updateInternal', () => {
  it('turns the public listing on with the same edit that changes anything else', async () => {
    const { service, sql } = build();

    const event = await service.updateInternal(
      EVENT,
      updateDto({ visibilityStatus: true, description: 'New text' }),
      staff,
    );
    const update = find(sql, 'UPDATE idp."T_HALL_BOOKING"');

    expect(event.visibilityStatus).toBe(true);
    expect(update.text).toContain('visibility_status =');
    expect(update.text).toContain('event_desc =');
    expect(update.params.slice(0, 2)).toEqual([EVENT, 'staff-1']);
  });

  it('changes only what is sent', async () => {
    const { service, sql } = build();
    await service.updateInternal(EVENT, updateDto({ expectedNumberOfVisitor: 900 }), staff);

    const update = find(sql, 'UPDATE idp."T_HALL_BOOKING"');
    const set = update.text.split('RETURNING')[0];
    expect(set).toContain('expected_number_of_visitor');
    expect(set).not.toContain('event_name');
    expect(set).not.toContain('org_id');
  });

  it('clears an optional field sent as null', async () => {
    const { service, sql } = build();
    await service.updateInternal(EVENT, updateDto({ specialRequest: null }), staff);

    expect(find(sql, 'UPDATE idp."T_HALL_BOOKING"').params).toEqual([EVENT, 'staff-1', null]);
  });

  it('cannot clear the name, the dates or a flag', async () => {
    const { service } = build();

    for (const field of ['name', 'startDate', 'endDate', 'visibilityStatus', 'fileNumber']) {
      await expect(
        service.updateInternal(EVENT, updateDto({ [field]: null }), staff),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('refuses an edit that changes nothing', async () => {
    await expect(build().service.updateInternal(EVENT, updateDto({}), staff)).rejects.toThrow(
      'Nothing to change.',
    );
  });

  it('checks the dates as they will stand, against what is saved', async () => {
    const { service } = build();

    // Saved: 2026-11-05 to 2026-11-29. Moving only the start past the saved end is refused.
    await expect(
      service.updateInternal(EVENT, updateDto({ startDate: '2026-12-15' }), staff),
    ).rejects.toThrow('cannot end before it starts');
    await expect(
      service.updateInternal(EVENT, updateDto({ endDate: '2026-11-01' }), staff),
    ).rejects.toThrow('cannot end before it starts');
    await expect(
      service.updateInternal(EVENT, updateDto({ startDate: '2026-02-30' }), staff),
    ).rejects.toThrow('not a real calendar date');
    expect(
      (await service.updateInternal(EVENT, updateDto({ endDate: '2026-12-31' }), staff)).id,
    ).toBe(EVENT);
  });

  it('is not found for an event that is not an internal one', async () => {
    await expect(
      build({ internalEvent: false }).service.updateInternal(
        EVENT,
        updateDto({ visibilityStatus: true }),
        staff,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('EventsService.addHalls', () => {
  it('adds a hall with only its id: name, code and area come from the hall, the rest from the system', async () => {
    const { service, sql } = build({ halls: HALLS });

    const result = await service.addHalls(EVENT, hallsDto([{ hallId: 64 }]));
    const insert = find(sql, 'INSERT INTO idp."T_EVENT_HALL"');

    expect(result.halls).toEqual([
      { id: 'eh-64', hallId: 64, name: 'Hall 11', forStallFnb: false },
    ]);
    expect(insert.params.slice(0, 8)).toEqual([
      EVENT,
      64,
      'Hall 11',
      false,
      true,
      'Approved',
      expect.any(Date),
      expect.any(Date),
    ]);
    expect(insert.params).toEqual(expect.arrayContaining(['H11', '5730']));
  });

  it('saves every field the user gives for the hall', async () => {
    const { service, sql } = build({ halls: HALLS });
    await service.addHalls(
      EVENT,
      hallsDto([
        {
          hallId: 64,
          hallCode: 'X1',
          hallArea: 6000,
          mountingPeriodFromDate: '2026-11-05',
          mountingPeriodToDate: '2026-11-13',
          exhibitionPeriodFromDate: '2026-11-14',
          exhibitionPeriodToDate: '2026-11-27',
          dismantlingPeriodFromDate: '2026-11-28',
          dismantlingPeriodToDate: '2026-11-29',
          numberOfComplimentaryDay: 1,
          remark: 'r',
          bookedArea: 5000,
          requestedArea: 5500,
          noOfStalls: 120,
          isNtaAreaRequest: true,
          ntaPricingType: 'ticketed',
        },
      ]),
    );
    const insert = find(sql, 'INSERT INTO idp."T_EVENT_HALL"');

    for (const column of [
      'mounting_period_from_date',
      'exhibition_period_to_date',
      'dismantling_period_to_date',
      'number_of_complimentary_day',
      'booked_area',
      'requested_area',
      'no_of_stalls',
      'nta_pricing_type',
    ]) {
      expect(insert.text).toContain(column);
    }
    // The user's code and area win over the hall's own.
    expect(insert.params).toEqual(expect.arrayContaining(['X1', 6000]));
    expect(insert.params).not.toContain('H11');
  });

  it('writes no price or rate columns', async () => {
    const { service, sql } = build({ halls: HALLS });
    await service.addHalls(EVENT, hallsDto([{ hallId: 64 }]));

    expect(find(sql, 'INSERT INTO idp."T_EVENT_HALL"').text).not.toMatch(
      /price|rate|amount|lean|peak/i,
    );
  });

  it('adds several halls at once', async () => {
    const { service } = build({ halls: HALLS });

    const result = await service.addHalls(EVENT, hallsDto([{ hallId: 64 }, { hallId: 65 }]));

    expect(result.halls.map((h) => h.name)).toEqual(['Hall 11', 'Hall 12']);
  });

  it('maps the F&B categories to an F&B hall, and skips the booked-dates check for it', async () => {
    const { service, sql } = build({
      halls: HALLS,
      fnbCategories: [117, 118, 119],
      clash: 'Another fair',
    });

    await service.addHalls(
      EVENT,
      hallsDto([
        {
          hallId: 76,
          forStallFnb: true,
          exhibitionPeriodFromDate: '2026-11-14',
          exhibitionPeriodToDate: '2026-11-27',
        },
      ]),
    );

    const mappings = sql.filter((q) =>
      q.text.includes('INSERT INTO idp."T_HALL_CATEGORY_MAPPING"'),
    );
    expect(mappings.map((q) => q.params)).toEqual([
      ['eh-76', 117],
      ['eh-76', 118],
      ['eh-76', 119],
    ]);
  });

  it('refuses a hall another event already holds on those days', async () => {
    const { service, sql } = build({ halls: HALLS, clash: 'Book Fair' });

    await expect(
      service.addHalls(
        EVENT,
        hallsDto([
          {
            hallId: 64,
            exhibitionPeriodFromDate: '2026-11-14',
            exhibitionPeriodToDate: '2026-11-27',
          },
        ]),
      ),
    ).rejects.toThrow('Hall 11 is already booked for those dates by Book Fair.');
    expect(sql.some((q) => q.text.includes('INSERT INTO idp."T_EVENT_HALL"'))).toBe(false);
  });

  it('does not look for a clash when the hall has no dates', async () => {
    const { service, sql } = build({ halls: HALLS, clash: 'Book Fair' });

    await service.addHalls(EVENT, hallsDto([{ hallId: 64 }]));

    expect(sql.some((q) => q.text.includes('JOIN idp."T_HALL_BOOKING" hb'))).toBe(false);
  });

  it('refuses a hall already in the event, one that does not exist, and a repeated one', async () => {
    const { service } = build({ halls: HALLS, alreadyAdded: [64] });

    await expect(service.addHalls(EVENT, hallsDto([{ hallId: 64 }]))).rejects.toThrow(
      ConflictException,
    );
    await expect(service.addHalls(EVENT, hallsDto([{ hallId: 999 }]))).rejects.toThrow(
      'Hall 999 does not exist.',
    );
    await expect(
      service.addHalls(EVENT, hallsDto([{ hallId: 65 }, { hallId: 65 }])),
    ).rejects.toThrow('more than once');
  });

  it('refuses a period with only one end, one that runs backwards, and a pricing type without NTA', async () => {
    const { service } = build({ halls: HALLS });

    await expect(
      service.addHalls(EVENT, hallsDto([{ hallId: 64, exhibitionPeriodFromDate: '2026-11-14' }])),
    ).rejects.toThrow('needs both');
    await expect(
      service.addHalls(
        EVENT,
        hallsDto([
          { hallId: 64, mountingPeriodFromDate: '2026-11-13', mountingPeriodToDate: '2026-11-05' },
        ]),
      ),
    ).rejects.toThrow('cannot end before');
    await expect(
      service.addHalls(EVENT, hallsDto([{ hallId: 64, ntaPricingType: 'ticketed' }])),
    ).rejects.toThrow('only for an NTA');
  });

  it('is not found for an event that is not an internal one', async () => {
    await expect(
      build({ halls: HALLS, internalEvent: false }).service.addHalls(
        EVENT,
        hallsDto([{ hallId: 64 }]),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('EventsService.updateHall', () => {
  it('changes only the fields sent, found by the event-hall id', async () => {
    const { service, sql } = build();

    const hall = await service.updateHall(
      EVENT,
      'eh-64',
      hallEditDto({ remark: 'moved', noOfStalls: 80 }),
    );
    const update = find(sql, 'UPDATE idp."T_EVENT_HALL"');

    expect(hall).toEqual({ id: 'eh-64', hallId: 64, name: 'Hall 11', forStallFnb: false });
    expect(update.text).toContain('remark =');
    expect(update.text).toContain('no_of_stalls =');
    expect(update.text).not.toContain('hall_code');
    expect(update.params.slice(0, 2)).toEqual(['eh-64', EVENT]);
  });

  it('clears an optional field sent as null, but not one that must have a value', async () => {
    const { service, sql } = build();

    await service.updateHall(EVENT, 'eh-64', hallEditDto({ remark: null }));
    expect(find(sql, 'UPDATE idp."T_EVENT_HALL"').params).toEqual(['eh-64', EVENT, null]);

    await expect(
      service.updateHall(EVENT, 'eh-64', hallEditDto({ numberOfComplimentaryDay: null })),
    ).rejects.toThrow('cannot be cleared');
    await expect(
      service.updateHall(EVENT, 'eh-64', hallEditDto({ forStallFnb: null })),
    ).rejects.toThrow('cannot be cleared');
  });

  it('refuses an edit that changes nothing', async () => {
    await expect(build().service.updateHall(EVENT, 'eh-64', hallEditDto({}))).rejects.toThrow(
      'Nothing to change.',
    );
  });

  it('checks a period as it will stand: a new end before the saved start is refused', async () => {
    const { service } = build();

    // Saved exhibition: 2026-11-14 to 2026-11-27.
    await expect(
      service.updateHall(EVENT, 'eh-64', hallEditDto({ exhibitionPeriodToDate: '2026-11-10' })),
    ).rejects.toThrow('cannot end before it starts');
    await expect(
      service.updateHall(EVENT, 'eh-64', hallEditDto({ mountingPeriodFromDate: '2026-11-05' })),
    ).rejects.toThrow('needs both');
  });

  it('refuses new dates another event already holds, and does not look when no date changed', async () => {
    const clashing = build({ clash: 'Book Fair' });
    await expect(
      clashing.service.updateHall(
        EVENT,
        'eh-64',
        hallEditDto({ exhibitionPeriodToDate: '2026-11-30' }),
      ),
    ).rejects.toThrow('Hall 11 is already booked for those dates by Book Fair.');
    expect(clashing.sql.some((q) => q.text.includes('UPDATE idp."T_EVENT_HALL"'))).toBe(false);

    const quiet = build({ clash: 'Book Fair' });
    await quiet.service.updateHall(EVENT, 'eh-64', hallEditDto({ remark: 'x' }));
    expect(quiet.sql.some((q) => q.text.includes('JOIN idp."T_HALL_BOOKING" hb'))).toBe(false);
  });

  it('maps the F&B categories when a hall becomes an F&B hall, and takes them off when it stops', async () => {
    const on = build({ fnbCategories: [117, 118] });
    await on.service.updateHall(EVENT, 'eh-64', hallEditDto({ forStallFnb: true }));
    expect(
      on.sql
        .filter((q) => q.text.includes('INSERT INTO idp."T_HALL_CATEGORY_MAPPING"'))
        .map((q) => q.params),
    ).toEqual([
      ['eh-64', 117],
      ['eh-64', 118],
    ]);
    expect(find(on.sql, 'UPDATE idp."T_EVENT_HALL"').text).toContain('is_stall_fnb =');

    const off = build({ eventHall: { ...SAVED_HALL, is_stall_fnb: true } });
    await off.service.updateHall(EVENT, 'eh-64', hallEditDto({ forStallFnb: false }));
    expect(off.sql.some((q) => q.text.includes('DELETE FROM idp."T_HALL_CATEGORY_MAPPING"'))).toBe(
      true,
    );
  });

  it('drops the NTA pricing type when the hall stops being an NTA request, and refuses it without one', async () => {
    const { service, sql } = build({
      eventHall: { ...SAVED_HALL, is_nta_area_request: true, nta_pricing_type: 'ticketed' },
    });
    await service.updateHall(EVENT, 'eh-64', hallEditDto({ isNtaAreaRequest: false }));
    expect(find(sql, 'UPDATE idp."T_EVENT_HALL"').text).toContain('nta_pricing_type =');

    await expect(
      build().service.updateHall(EVENT, 'eh-64', hallEditDto({ ntaPricingType: 'ticketed' })),
    ).rejects.toThrow('only for an NTA');
  });

  it('is not found for a hall that is not in this event, or an event that is not internal', async () => {
    await expect(
      build({ eventHall: null }).service.updateHall(EVENT, 'eh-64', hallEditDto({ remark: 'x' })),
    ).rejects.toThrow('Hall not found in this event.');
    await expect(
      build({ internalEvent: false }).service.updateHall(
        EVENT,
        'eh-64',
        hallEditDto({ remark: 'x' }),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('EventsService.removeHall', () => {
  it('takes the hall out of the event by deleting its row', async () => {
    const { service, sql } = build();

    await service.removeHall(EVENT, 'eh-64');

    expect(find(sql, 'DELETE FROM idp."T_EVENT_HALL"').params).toEqual(['eh-64', EVENT]);
  });

  it('refuses a hall that already has a plan in the event, and one with booked services', async () => {
    const planned = build({ planned: true });
    await expect(planned.service.removeHall(EVENT, 'eh-64')).rejects.toThrow('already has a plan');
    expect(planned.sql.some((q) => q.text.includes('DELETE FROM idp."T_EVENT_HALL"'))).toBe(false);

    await expect(build({ serviced: true }).service.removeHall(EVENT, 'eh-64')).rejects.toThrow(
      'has services booked',
    );
  });

  it('is not found for a hall that is not in this event, or an event that is not internal', async () => {
    await expect(build({ eventHall: null }).service.removeHall(EVENT, 'eh-64')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      build({ internalEvent: false }).service.removeHall(EVENT, 'eh-64'),
    ).rejects.toThrow(NotFoundException);
  });
});
