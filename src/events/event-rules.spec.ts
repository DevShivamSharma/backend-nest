import type { OrgAccessContext } from '../common/http/authenticated-request';
import { RoleScopeKind } from '../roles/role.entity';
import {
  canMove,
  daysOverlap,
  eventInScope,
  isOpen,
  isRealDay,
  scopedEventIds,
  today,
} from './event-rules';

const access = (scopeKind: RoleScopeKind, eventIds?: string[]) =>
  ({
    membership: { role: { scopeKind }, scope: eventIds ? { eventIds } : {} },
  }) as unknown as OrgAccessContext;

describe('event rules', () => {
  it('moves through the life cycle and treats completed and cancelled as final', () => {
    expect(canMove('draft', 'scheduled')).toBe(true);
    expect(canMove('scheduled', 'draft')).toBe(true);
    expect(canMove('scheduled', 'completed')).toBe(true);
    expect(canMove('draft', 'completed')).toBe(false);
    expect(canMove('cancelled', 'draft')).toBe(false);
    expect(canMove('completed', 'scheduled')).toBe(false);
    expect([
      isOpen('draft'),
      isOpen('scheduled'),
      isOpen('completed'),
      isOpen('cancelled'),
    ]).toEqual([true, true, false, false]);
  });

  it('accepts only real calendar days', () => {
    expect(isRealDay('2026-02-28')).toBe(true);
    expect(isRealDay('2028-02-29')).toBe(true);
    expect(isRealDay('2026-02-29')).toBe(false);
    expect(isRealDay('2026-13-01')).toBe(false);
    expect(today(new Date('2026-10-08T23:30:00Z'))).toBe('2026-10-08');
  });

  it('counts a shared first or last day as an overlap', () => {
    const fair = { startsOn: '2026-11-14', endsOn: '2026-11-27' };
    expect(daysOverlap(fair, { startsOn: '2026-11-27', endsOn: '2026-11-30' })).toBe(true);
    expect(daysOverlap(fair, { startsOn: '2026-11-01', endsOn: '2026-11-14' })).toBe(true);
    expect(daysOverlap(fair, { startsOn: '2026-11-28', endsOn: '2026-12-02' })).toBe(false);
    expect(daysOverlap(fair, { startsOn: '2026-11-01', endsOn: '2026-11-13' })).toBe(false);
  });

  it('shows an event role only its own events, and an empty list nothing', () => {
    expect(scopedEventIds(access(RoleScopeKind.Organisation))).toBeNull();
    expect(eventInScope(access(RoleScopeKind.Organisation), 'any')).toBe(true);
    expect(eventInScope(access(RoleScopeKind.Event, ['a']), 'a')).toBe(true);
    expect(eventInScope(access(RoleScopeKind.Event, ['a']), 'b')).toBe(false);
    expect(eventInScope(access(RoleScopeKind.Event), 'a')).toBe(false);
  });
});
