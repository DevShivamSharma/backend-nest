import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { DEFAULT_RULE_VALUES, RULE_IDS } from '../domain/rule-catalogue';
import { RulesService } from './rules.service';

const staff: SessionUser = {
  id: 's1',
  email: '',
  name: '',
  type: UserType.ItpoStaff,
  roles: [],
  orgId: null,
  organisationName: null,
};
const organiser: SessionUser = {
  id: 'o1',
  email: '',
  name: '',
  type: UserType.Organiser,
  roles: [],
  orgId: 'org-1',
  organisationName: 'Acme Expo',
};

const EVENTS: Record<
  string,
  { id: string; event_name: string; event_booking_type: string | null; org_id: string | null }
> = {
  internal: {
    id: 'internal',
    event_name: 'ITPO fair',
    event_booking_type: 'internal',
    org_id: null,
  },
  external: { id: 'external', event_name: 'Trade show', event_booking_type: null, org_id: 'org-1' },
  other: { id: 'other', event_name: 'Someone else', event_booking_type: null, org_id: 'org-2' },
};

/** An in-memory stand-in for the three tables the service reads and writes. */
function build() {
  const ruleSet = {
    switches: {} as Record<string, boolean>,
    rule_values: {} as Record<string, unknown>,
    doc_references: [] as unknown[],
    drawing_profile: 'free',
    updated_at: new Date('2026-10-23T00:00:00Z'),
  };
  const overrides = new Map<string, boolean>(); // `${event}:${rule}` -> enabled
  const hallOverrides = new Map<string, boolean>(); // `${hall}:${rule}` -> enabled
  const writes: string[] = [];

  const tx = {
    query: (text: string, params: unknown[] = []) => {
      if (text.includes('FROM idp."T_RULE_SET"')) return Promise.resolve([ruleSet]);
      if (text.includes('UPDATE idp."T_RULE_SET"')) {
        writes.push('rule set');
        ruleSet.switches = JSON.parse(params[0] as string);
        ruleSet.rule_values = JSON.parse(params[1] as string);
        ruleSet.doc_references = JSON.parse(params[2] as string);
        ruleSet.drawing_profile = params[3] as string;
        // As TypeORM answers an UPDATE ... RETURNING: [rows, affected count].
        return Promise.resolve([[ruleSet], 1]);
      }
      if (text.includes('FROM idp."T_HALL_BOOKING"')) {
        const event = EVENTS[params[0] as string];
        return Promise.resolve(event ? [event] : []);
      }
      if (text.includes('SELECT rule_id, enabled FROM idp."T_EVENT_RULE_SWITCH"')) {
        return Promise.resolve(
          [...overrides]
            .filter(([k]) => k.startsWith(`${params[0]}:`))
            .map(([k, enabled]) => ({ rule_id: k.split(':')[1], enabled })),
        );
      }
      if (text.includes('DELETE FROM idp."T_EVENT_RULE_SWITCH"')) {
        writes.push('delete');
        overrides.delete(`${params[0]}:${params[1]}`);
        return Promise.resolve([]);
      }
      if (text.includes('INSERT INTO idp."T_EVENT_RULE_SWITCH"')) {
        writes.push('upsert');
        overrides.set(`${params[0]}:${params[1]}`, params[2] as boolean);
        return Promise.resolve([]);
      }
      if (text.includes('FROM idp."T_HALLS"')) {
        return Promise.resolve(params[0] === 7 ? [{ id: 7, name: 'Hall 7' }] : []);
      }
      if (text.includes('SELECT rule_id, enabled FROM idp."T_HALL_RULE_SWITCH"')) {
        return Promise.resolve(
          [...hallOverrides]
            .filter(([k]) => k.startsWith(`${params[0]}:`))
            .map(([k, enabled]) => ({ rule_id: k.split(':')[1], enabled })),
        );
      }
      if (text.includes('DELETE FROM idp."T_HALL_RULE_SWITCH"')) {
        writes.push('hall delete');
        hallOverrides.delete(`${params[0]}:${params[1]}`);
        return Promise.resolve([]);
      }
      if (text.includes('INSERT INTO idp."T_HALL_RULE_SWITCH"')) {
        writes.push('hall upsert');
        hallOverrides.set(`${params[0]}:${params[1]}`, params[2] as boolean);
        return Promise.resolve([]);
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
  const db = {
    manager: tx,
    transaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DataSource;
  return {
    service: new RulesService(db, { record: () => Promise.resolve() } as never),
    writes,
    db: tx as unknown as EntityManager,
  };
}

describe('the rule set', () => {
  it('starts with every rule on and the default values', async () => {
    const view = await build().service.get();

    expect(Object.values(view.switches).every(Boolean)).toBe(true);
    expect(Object.keys(view.switches)).toEqual([...RULE_IDS]);
    expect(view.values).toEqual(DEFAULT_RULE_VALUES);
    expect(view.drawingProfile).toBe('free');
  });

  it('switches a rule off for every hall, and only known rules', async () => {
    const { service } = build();

    const view = await service.update({ switches: { PILLAR: false } }, staff);
    expect(view.switches.PILLAR).toBe(false);
    expect(view.switches.hallBoundary).toBe(true);

    await expect(service.update({ switches: { notARule: false } }, staff)).rejects.toThrow(
      '"notARule" is not a rule.',
    );
  });

  it('keeps values within their limits', async () => {
    const { service } = build();
    const tooNarrow = { ...DEFAULT_RULE_VALUES, passageWidth: { B2B: 1, B2C: 3 } };

    await expect(service.update({ values: tooNarrow }, staff)).rejects.toThrow(BadRequestException);

    const wider = { ...DEFAULT_RULE_VALUES, passageWidth: { B2B: 4, B2C: 3 } };
    expect((await service.update({ values: wider }, staff)).values.passageWidth.B2B).toBe(4);
  });

  it('refuses a drawing profile that does not exist', async () => {
    await expect(build().service.update({ drawingProfile: 'laser' }, staff)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('leaves what is not sent as it was', async () => {
    const { service } = build();
    await service.update({ switches: { PILLAR: false } }, staff);
    const view = await service.update({ drawingProfile: 'grid' }, staff);

    expect(view.switches.PILLAR).toBe(false);
    expect(view.drawingProfile).toBe('grid');
  });
});

describe("an event's rules", () => {
  it('follow the rule set until the event changes them', async () => {
    const { service } = build();
    await service.update({ switches: { PILLAR: false } }, staff);

    const view = await service.forEvent('external', staff);

    expect(view.event).toEqual({ id: 'external', name: 'Trade show', kind: 'external' });
    expect(view.rules.find((r) => r.id === 'PILLAR')).toEqual({
      id: 'PILLAR',
      enabled: false,
      defaultEnabled: false,
      overridden: false,
    });
    expect(view.rules.find((r) => r.id === 'FOYER')).toEqual({
      id: 'FOYER',
      enabled: true,
      defaultEnabled: true,
      overridden: false,
    });
  });

  it('are all off for an internal event, whatever the default says, and cannot be changed', async () => {
    const { service, writes } = build();

    const view = await service.forEvent('internal', staff);
    expect(view.rules.every((r) => !r.enabled && !r.overridden)).toBe(true);

    const effective = await service.effective(
      {
        query: (text: string) =>
          Promise.resolve(
            text.includes('T_RULE_SET')
              ? [{ switches: {}, rule_values: {}, drawing_profile: 'free' }]
              : text.includes('T_HALL_BOOKING')
                ? [{ event_booking_type: 'internal' }]
                : [],
          ),
      } as never,
      'internal',
    );
    expect(Object.values(effective.switches).every((on) => on === false)).toBe(true);

    await expect(
      service.setForEvent('internal', { switches: { FOYER: true } }, staff),
    ).rejects.toThrow('always off for an internal event');
    expect(writes).toEqual([]);
  });

  it('let ITPO staff switch rules off for an external event', async () => {
    const view = await build().service.setForEvent(
      'external',
      { switches: { maxUtilization: false } },
      staff,
    );

    expect(view.event.kind).toBe('external');
    expect(view.rules.find((r) => r.id === 'maxUtilization')?.enabled).toBe(false);
  });

  it('can switch on a rule the set has off, and go back to the default with null', async () => {
    const { service } = build();
    await service.update({ switches: { PILLAR: false } }, staff);

    const on = await service.setForEvent('external', { switches: { PILLAR: true } }, staff);
    expect(on.rules.find((r) => r.id === 'PILLAR')).toMatchObject({
      enabled: true,
      overridden: true,
    });

    const back = await service.setForEvent('external', { switches: { PILLAR: null } }, staff);
    expect(back.rules.find((r) => r.id === 'PILLAR')).toMatchObject({
      enabled: false,
      overridden: false,
    });
  });

  it("keep one event's switches apart from another's", async () => {
    const { service } = build();
    await service.setForEvent('external', { switches: { FOYER: false } }, staff);

    const other = await service.forEvent('other', staff);
    expect(other.rules.find((r) => r.id === 'FOYER')?.enabled).toBe(true);
  });

  it('refuse an unknown rule before changing anything', async () => {
    const { service, writes } = build();

    await expect(
      service.setForEvent('external', { switches: { FOYER: false, nope: false } }, staff),
    ).rejects.toThrow('"nope" is not a rule.');
    expect(writes).toEqual([]);
  });

  it('are not found for an event ITPO has no booking for', async () => {
    await expect(build().service.forEvent('missing', staff)).rejects.toThrow(NotFoundException);
  });

  it('can be read by an organiser for their own event only', async () => {
    const { service } = build();

    expect((await service.forEvent('external', organiser)).event.id).toBe('external');
    await expect(service.forEvent('other', organiser)).rejects.toThrow(ForbiddenException);
  });
});

describe("a hall's rules", () => {
  it('should follow the default until ITPO switches a rule for the hall', async () => {
    const { service } = build();
    await service.update({ switches: { PILLAR: false } }, staff);

    const view = await service.setForHall(7, { switches: { FOYER: false, PILLAR: true } }, staff);

    expect(view.hall).toEqual({ id: 7, name: 'Hall 7' });
    expect(view.rules.find((r) => r.id === 'FOYER')).toEqual({
      id: 'FOYER',
      enabled: false,
      defaultEnabled: true,
      overridden: true,
    });
    expect(view.rules.find((r) => r.id === 'PILLAR')).toMatchObject({
      enabled: true,
      overridden: true,
    });
    expect(view.rules.find((r) => r.id === 'maxUtilization')).toMatchObject({ overridden: false });

    const back = await service.setForHall(7, { switches: { FOYER: null } }, staff);
    expect(back.rules.find((r) => r.id === 'FOYER')).toMatchObject({
      enabled: true,
      overridden: false,
    });
  });

  it('should layer the default, then the hall, then the event; internal events keep every rule off', async () => {
    const { service, db } = build();
    await service.setForHall(7, { switches: { FOYER: false } }, staff);

    const hallOnly = await service.effective(db, 'external', 7);
    expect(hallOnly.switches['FOYER']).toBe(false);
    expect(hallOnly.switches['PILLAR']).toBe(true);

    await service.setForEvent('external', { switches: { FOYER: true } }, staff);
    expect((await service.effective(db, 'external', 7)).switches['FOYER']).toBe(true);
    expect((await service.effective(db, 'external', 8)).switches['FOYER']).toBe(true);

    const internal = await service.effective(db, 'internal', 7);
    expect(Object.values(internal.switches).every((on) => on === false)).toBe(true);
  });

  it('should refuse an unknown rule and an unknown hall, before writing', async () => {
    const { service, writes } = build();
    await expect(service.setForHall(7, { switches: { nope: false } }, staff)).rejects.toThrow(
      'not a rule',
    );
    await expect(service.setForHall(99, { switches: { FOYER: false } }, staff)).rejects.toThrow(
      'Hall not found',
    );
    expect(writes).toEqual([]);
  });
});
