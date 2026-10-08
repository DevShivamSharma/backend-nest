import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { MembershipScope } from '../access/membership-scope';
import { RoleEntity, RoleScopeKind } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';

/** What an invitation or role change asks for besides the role. */
export interface ScopeInput {
  eventIds?: readonly string[] | null;
  exhibitorId?: string | null;
}

/**
 * The scope a role is given with. A whole-organisation role has none. An event role names at
 * least one live event of the organisation — only ones the granter works on, when the granter
 * is event-scoped itself — and, when it books stalls, the exhibitor it books for, which must
 * take part in each of those events. `granterEvents` is null for a whole-organisation granter.
 */
export async function resolveScope(
  em: EntityManager,
  organisationId: string,
  role: RoleEntity,
  input: ScopeInput,
  granterEvents: readonly string[] | null,
): Promise<MembershipScope> {
  const eventIds = [...new Set(input.eventIds ?? [])];
  if (role.scopeKind !== RoleScopeKind.Event) {
    if (granterEvents) {
      throw new ForbiddenException('You can give only event roles, for your own events.');
    }
    if (eventIds.length || input.exhibitorId) {
      throw new BadRequestException(
        'A whole-organisation role is not limited to events or an exhibitor.',
      );
    }
    return {};
  }

  if (!eventIds.length) {
    throw new BadRequestException('Choose the events this person works on.');
  }
  if (granterEvents && eventIds.some((id) => !granterEvents.includes(id))) {
    throw new ForbiddenException('You can give access only to your own events.');
  }
  const events: { id: string; name: string; status: string }[] = await em.query(
    `SELECT id, name, status FROM events WHERE organisation_id = $1 AND id = ANY($2::uuid[])`,
    [organisationId, eventIds],
  );
  if (events.length !== eventIds.length) {
    throw new BadRequestException('Some of these events are not in this organisation.');
  }
  const cancelled = events.find((e) => e.status === 'cancelled');
  if (cancelled) throw new BadRequestException(`${cancelled.name} is cancelled.`);

  if (!booksStalls(role)) {
    if (input.exhibitorId) {
      throw new BadRequestException('Only a role that books stalls acts for an exhibitor.');
    }
    return { eventIds };
  }
  if (!input.exhibitorId) {
    throw new BadRequestException('Choose the exhibitor this person books stalls for.');
  }
  const [exhibitor]: { id: string; name: string }[] = await em.query(
    `SELECT id, name FROM exhibitors WHERE organisation_id = $1 AND id = $2`,
    [organisationId, input.exhibitorId],
  );
  if (!exhibitor) {
    throw new BadRequestException('There is no such exhibitor in this organisation.');
  }
  const registered: { event_id: string }[] = await em.query(
    `SELECT event_id FROM event_exhibitors WHERE exhibitor_id = $1 AND event_id = ANY($2::uuid[])`,
    [exhibitor.id, eventIds],
  );
  const missing = events.filter((e) => !registered.some((r) => r.event_id === e.id));
  if (missing.length) {
    throw new BadRequestException(
      `Register ${exhibitor.name} for ${missing.map((e) => e.name).join(', ')} first.`,
    );
  }
  return { eventIds, exhibitorId: exhibitor.id };
}

/** Event roles can be given once the organisation has a live event. */
export async function hasLiveEvents(em: EntityManager, organisationId: string): Promise<boolean> {
  const [{ found }]: { found: boolean }[] = await em.query(
    `SELECT EXISTS (
       SELECT 1 FROM events WHERE organisation_id = $1 AND status <> 'cancelled'
     ) AS found`,
    [organisationId],
  );
  return found;
}

export function booksStalls(role: RoleEntity): boolean {
  return RolesService.effectivePermissions(role).includes('stalls.book');
}

/**
 * Whether an event-scoped member may see or act on someone with `role` and `scope`: only
 * event-role members, all of whose events are among `events`.
 */
export function withinEvents(
  role: RoleEntity | undefined,
  scope: MembershipScope,
  events: readonly string[],
): boolean {
  const theirs = scope.eventIds ?? [];
  return (
    role?.scopeKind === RoleScopeKind.Event &&
    theirs.length > 0 &&
    theirs.every((id) => events.includes(id))
  );
}

export function sameScope(a: MembershipScope, b: MembershipScope): boolean {
  const ids = (s: MembershipScope) => [...(s.eventIds ?? [])].sort().join(',');
  return ids(a) === ids(b) && (a.exhibitorId ?? null) === (b.exhibitorId ?? null);
}
