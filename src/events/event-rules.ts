import type { OrgAccessContext } from '../common/http/authenticated-request';
import { RoleScopeKind } from '../roles/role.entity';
import type { EventStatus } from './event.entity';

/**
 * The event rules that need no database: its life cycle, its dates and who sees it. Pure, so
 * they are unit-tested on their own.
 */

/** Moves an event may make. Completed and cancelled are final. */
const NEXT: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['draft', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canMove(from: EventStatus, to: EventStatus): boolean {
  return NEXT[from].includes(to);
}

/** Draft and scheduled events can still change; completed and cancelled ones cannot. */
export function isOpen(status: EventStatus): boolean {
  return status === 'draft' || status === 'scheduled';
}

/** True when a `YYYY-MM-DD` string names a real calendar day. */
export function isRealDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** Two whole-day ranges share at least one day (both ends included). */
export function daysOverlap(
  a: { startsOn: string; endsOn: string },
  b: { startsOn: string; endsOn: string },
): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

/** Today in UTC, `YYYY-MM-DD`. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The events an event-scoped member works on; null for a member of the whole organisation.
 * Unlike `scopeAllows`, an event role with no events listed sees no event, never all of them.
 */
export function scopedEventIds(access: OrgAccessContext): readonly string[] | null {
  return access.membership.role?.scopeKind === RoleScopeKind.Event
    ? (access.membership.scope.eventIds ?? [])
    : null;
}

export function eventInScope(access: OrgAccessContext, eventId: string): boolean {
  const ids = scopedEventIds(access);
  return ids === null || ids.includes(eventId);
}
