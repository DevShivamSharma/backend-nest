import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';

import { MembershipEntity } from '../access/membership.entity';
import { AuditService } from '../audit/audit.service';
import type { Actor, AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { EventsService } from '../events/events.service';
import { RoleEntity } from '../roles/role.entity';
import { InvitationEntity } from '../team/invitation.entity';
import { InvitationsService } from '../team/invitations.service';
import { TeamService } from '../team/team.service';
import type { CreatedInvitationView } from '../team/team.views';
import {
  CreateExhibitorDto,
  InviteExhibitorPersonDto,
  ListExhibitorsQuery,
  UpdateExhibitorDto,
} from './dto/exhibitor.dto';
import { EventExhibitorEntity, ExhibitorEntity } from './exhibitor.entity';
import type { ExhibitorPeopleView, ExhibitorView } from './exhibitor.views';

/** The platform's event-scoped role for people who book stalls (PlatformFoundation's seed). */
const EXHIBITOR_ROLE_KEY = 'exhibitor';

/**
 * The companies that take stalls, and the events they are registered for (docs/15 §3.3; ported
 * from `@feature/rules`). Members of the whole organisation see every exhibitor; organisers only
 * those registered for their events, and they add new ones to one of their events.
 */
@Injectable()
export class ExhibitorsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
  ) {}

  async list(access: OrgAccessContext, query: ListExhibitorsQuery = {}): Promise<ExhibitorView[]> {
    const em = this.dataSource.manager;
    if (query.eventId) await this.events.eventFor(em, access, query.eventId);
    const filter = query.eventId ? [query.eventId] : EventsService.visibleIds(access);
    const qb = em
      .getRepository(ExhibitorEntity)
      .createQueryBuilder('exhibitor')
      .where('exhibitor.organisationId = :organisationId', {
        organisationId: access.organisation.id,
      });
    if (filter) {
      if (!filter.length) return [];
      qb.andWhere(
        `EXISTS (SELECT 1 FROM event_exhibitors ee
                  WHERE ee.exhibitor_id = exhibitor.id AND ee.event_id IN (:...filter))`,
        { filter },
      );
    }
    const exhibitors = await qb.orderBy('lower(exhibitor.name)', 'ASC').getMany();
    return this.views(em, access, exhibitors);
  }

  async get(access: OrgAccessContext, exhibitorId: string): Promise<ExhibitorView> {
    const em = this.dataSource.manager;
    const [view] = await this.views(em, access, [await this.getVisible(em, access, exhibitorId)]);
    return view;
  }

  async create(
    access: OrgAccessContext,
    dto: CreateExhibitorDto,
    actor: Actor,
  ): Promise<ExhibitorView> {
    const organisationId = access.organisation.id;
    if (EventsService.isOrganiser(access) && !dto.eventId) {
      throw new BadRequestException('Choose the event the new exhibitor takes part in.');
    }
    const exhibitor = await this.dataSource.transaction(async (em) => {
      const event = dto.eventId ? await this.events.eventFor(em, access, dto.eventId, true) : null;
      if (event) EventsService.assertOpen(event);
      await this.assertNameFree(em, organisationId, dto.name);
      const repo = em.getRepository(ExhibitorEntity);
      const exhibitor = await repo.save(
        repo.create({
          organisationId,
          name: dto.name,
          contactName: dto.contactName ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          gstin: dto.gstin ?? null,
          address: dto.address ?? null,
        }),
      );
      if (event) {
        await em
          .getRepository(EventExhibitorEntity)
          .insert({ eventId: event.id, exhibitorId: exhibitor.id });
      }
      await this.audit.record(
        {
          action: 'exhibitor.created',
          actor,
          organisationId,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, ...(event ? { event: event.name } : {}) },
        },
        em,
      );
      return exhibitor;
    });
    return this.get(access, exhibitor.id);
  }

  async update(
    access: OrgAccessContext,
    exhibitorId: string,
    dto: UpdateExhibitorDto,
    actor: Actor,
  ): Promise<ExhibitorView> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const exhibitor = await this.getVisible(em, access, exhibitorId, true);
      const changed: string[] = [];
      if (dto.name !== undefined && dto.name !== exhibitor.name) {
        await this.assertNameFree(em, organisationId, dto.name, exhibitor.id);
        exhibitor.name = dto.name;
        changed.push('name');
      }
      for (const key of ['contactName', 'email', 'phone', 'gstin', 'address'] as const) {
        if (dto[key] !== undefined && (dto[key] ?? null) !== exhibitor[key]) {
          exhibitor[key] = dto[key] ?? null;
          changed.push(key);
        }
      }
      if (!changed.length) return;
      await em.getRepository(ExhibitorEntity).save(exhibitor);
      await this.audit.record(
        {
          action: 'exhibitor.updated',
          actor,
          organisationId,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, changed },
        },
        em,
      );
    });
    return this.get(access, exhibitorId);
  }

  /** Only an exhibitor registered for no event: a registration carries its bookings. */
  async remove(access: OrgAccessContext, exhibitorId: string, actor: Actor): Promise<void> {
    if (EventsService.isOrganiser(access)) {
      throw new ForbiddenException(`${access.organisation.name}’s team deletes exhibitors.`);
    }
    await this.dataSource.transaction(async (em) => {
      const exhibitor = await this.getVisible(em, access, exhibitorId, true);
      const n = await em.getRepository(EventExhibitorEntity).countBy({ exhibitorId });
      if (n) {
        throw new ConflictException(
          `${exhibitor.name} is registered for ${n} ${n === 1 ? 'event' : 'events'}. Take it off ${n === 1 ? 'that event' : 'those events'} first.`,
        );
      }
      const { members, invitations } = await this.peopleOf(
        em,
        access.organisation.id,
        exhibitor.id,
      );
      if (members.length || invitations.length) {
        throw new ConflictException(
          `${exhibitor.name} has people who book for it. Remove them, and revoke their invitations, on the Team page first.`,
        );
      }
      await em.getRepository(ExhibitorEntity).delete({ id: exhibitor.id });
      await this.audit.record(
        {
          action: 'exhibitor.deleted',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name },
        },
        em,
      );
    });
  }

  /** Registers the exhibitor for an event that still changes; registering twice does nothing. */
  async register(
    access: OrgAccessContext,
    eventId: string,
    exhibitorId: string,
    actor: Actor,
  ): Promise<ExhibitorView> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.eventFor(em, access, eventId, true);
      EventsService.assertOpen(event);
      const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId);
      const links = em.getRepository(EventExhibitorEntity);
      if (await links.existsBy({ eventId, exhibitorId })) return;
      await links.insert({ eventId, exhibitorId });
      await this.syncPeople(em, access.organisation.id, exhibitorId, eventId, true);
      await this.audit.record(
        {
          action: 'exhibitor.registered',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, event: event.name },
        },
        em,
      );
    });
    return this.get(access, exhibitorId);
  }

  /** Not while it has bookings at the event, active or past: they keep it registered. */
  async unregister(
    access: OrgAccessContext,
    eventId: string,
    exhibitorId: string,
    actor: Actor,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const event = await this.events.eventFor(em, access, eventId, true);
      const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId);
      const link = await em.getRepository(EventExhibitorEntity).findOneBy({ eventId, exhibitorId });
      if (!link) throw new NotFoundException(`${exhibitor.name} is not registered for this event.`);
      const [{ count }]: Array<{ count: number }> = await em.query(
        `SELECT count(*)::int AS count FROM bookings WHERE event_id = $1 AND exhibitor_id = $2`,
        [eventId, exhibitorId],
      );
      if (count) {
        throw new ConflictException(
          `${exhibitor.name} has ${count} ${count === 1 ? 'booking' : 'bookings'} at ${event.name}, so it stays registered.`,
        );
      }
      await em.getRepository(EventExhibitorEntity).delete({ eventId, exhibitorId });
      await this.syncPeople(em, access.organisation.id, exhibitorId, eventId, false);
      await this.audit.record(
        {
          action: 'exhibitor.unregistered',
          actor,
          organisationId: access.organisation.id,
          targetType: 'exhibitor',
          targetId: exhibitor.id,
          metadata: { name: exhibitor.name, event: event.name },
        },
        em,
      );
    });
  }

  // ---- people -------------------------------------------------------------------------------

  /** The members who book for the exhibitor, and the open invitations to do so. */
  async people(access: OrgAccessContext, exhibitorId: string): Promise<ExhibitorPeopleView> {
    const em = this.dataSource.manager;
    const exhibitor = await this.getVisible(em, access, exhibitorId);
    const { members, invitations } = await this.peopleOf(em, access.organisation.id, exhibitor.id);
    return {
      members: members.map(TeamService.view),
      invitations: invitations.map((i) => InvitationsService.view(i, i.role!, i.invitedBy ?? null)),
    };
  }

  /**
   * Invites a person who books stalls for this exhibitor (docs/15 §9 Q13: invite-only): the
   * platform's event-scoped Exhibitor role, for each event the exhibitor is registered for that
   * the inviter sees, with the exhibitor named in the scope. As for every role, the inviter must
   * hold what the role gives.
   */
  async invitePerson(
    access: OrgAccessContext,
    exhibitorId: string,
    dto: InviteExhibitorPersonDto,
    user: AuthUser,
  ): Promise<CreatedInvitationView> {
    const em = this.dataSource.manager;
    const exhibitor = await this.getVisible(em, access, exhibitorId);
    const [view] = await this.views(em, access, [exhibitor]);
    if (!view.eventIds.length) {
      throw new ConflictException(
        `Register ${exhibitor.name} for an event first: its people see only the events it takes part in.`,
      );
    }
    const role = await em
      .getRepository(RoleEntity)
      .findOneBy({ key: EXHIBITOR_ROLE_KEY, organisationId: IsNull() });
    if (!role) throw new NotFoundException('The Exhibitor role is missing. Ask the platform team.');
    const { view: invitation } = await this.invitations.invite(
      access.organisation,
      {
        email: dto.email,
        roleId: role.id,
        scope: { eventIds: view.eventIds, exhibitorId: exhibitor.id },
      },
      { actor: user, permissions: access.permissions },
    );
    return invitation;
  }

  // ---- building blocks, also used by bookings ----------------------------------------------

  /** The organisation's exhibitor, whoever asks; 404 for anything else. */
  async getOwn(
    em: EntityManager,
    organisationId: string,
    exhibitorId: string,
    lock = false,
  ): Promise<ExhibitorEntity> {
    const exhibitor = await em.getRepository(ExhibitorEntity).findOne({
      where: { id: exhibitorId, organisationId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!exhibitor) throw new NotFoundException('There is no such exhibitor in this organisation.');
    return exhibitor;
  }

  isRegistered(em: EntityManager, eventId: string, exhibitorId: string): Promise<boolean> {
    return em.getRepository(EventExhibitorEntity).existsBy({ eventId, exhibitorId });
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** The exhibitor when the member may see it: organisers, at their events only. */
  private async getVisible(
    em: EntityManager,
    access: OrgAccessContext,
    exhibitorId: string,
    lock = false,
  ): Promise<ExhibitorEntity> {
    const exhibitor = await this.getOwn(em, access.organisation.id, exhibitorId, lock);
    const visible = EventsService.visibleIds(access);
    if (visible) {
      const seen = visible.length
        ? await em
            .getRepository(EventExhibitorEntity)
            .existsBy({ exhibitorId, eventId: In(visible) })
        : false;
      if (!seen) throw new NotFoundException('There is no such exhibitor in this organisation.');
    }
    return exhibitor;
  }

  private async views(
    em: EntityManager,
    access: OrgAccessContext,
    exhibitors: ExhibitorEntity[],
  ): Promise<ExhibitorView[]> {
    const ids = exhibitors.map((e) => e.id);
    const links = ids.length
      ? await em.getRepository(EventExhibitorEntity).findBy({ exhibitorId: In(ids) })
      : [];
    const visible = EventsService.visibleIds(access);
    const events = new Map<string, string[]>();
    for (const link of links) {
      if (visible && !visible.includes(link.eventId)) continue;
      events.set(link.exhibitorId, [...(events.get(link.exhibitorId) ?? []), link.eventId]);
    }
    return exhibitors.map((e) => ({
      id: e.id,
      name: e.name,
      contactName: e.contactName,
      email: e.email,
      phone: e.phone,
      gstin: e.gstin,
      address: e.address,
      eventIds: events.get(e.id) ?? [],
      createdAt: e.createdAt.toISOString(),
    }));
  }

  /** Members and open invitations whose scope names this exhibitor. */
  private async peopleOf(
    em: EntityManager,
    organisationId: string,
    exhibitorId: string,
  ): Promise<{ members: MembershipEntity[]; invitations: InvitationEntity[] }> {
    const members = await em
      .getRepository(MembershipEntity)
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.user', 'u')
      .innerJoinAndSelect('m.role', 'r')
      .where('m.organisationId = :organisationId', { organisationId })
      .andWhere(`m.scope ->> 'exhibitorId' = :exhibitorId`, { exhibitorId })
      .orderBy('u.name', 'ASC')
      .getMany();
    const invitations = await em
      .getRepository(InvitationEntity)
      .createQueryBuilder('i')
      .innerJoinAndSelect('i.role', 'r')
      .leftJoinAndSelect('i.invitedBy', 'by')
      .where('i.organisationId = :organisationId', { organisationId })
      .andWhere('i.acceptedAt IS NULL AND i.revokedAt IS NULL')
      .andWhere(`i.scope ->> 'exhibitorId' = :exhibitorId`, { exhibitorId })
      .orderBy('i.createdAt', 'DESC')
      .getMany();
    return { members, invitations };
  }

  /**
   * The exhibitor's people see the events it takes part in: registering adds the event to their
   * scope (members and open invitations alike), unregistering takes it out. Done in SQL on the
   * jsonb scope so one statement covers everyone, inside the registration's transaction.
   */
  private async syncPeople(
    em: EntityManager,
    organisationId: string,
    exhibitorId: string,
    eventId: string,
    add: boolean,
  ): Promise<void> {
    const events = `COALESCE(scope -> 'eventIds', '[]'::jsonb)`;
    const next = add ? `${events} || to_jsonb($2::text)` : `${events} - $2::text`;
    const only = add ? `AND NOT ${events} ? $2` : '';
    await em.query(
      `UPDATE memberships SET scope = jsonb_set(scope, '{eventIds}', ${next}), updated_at = now()
        WHERE organisation_id = $1 AND scope ->> 'exhibitorId' = $3 ${only}`,
      [organisationId, eventId, exhibitorId],
    );
    await em.query(
      `UPDATE invitations SET scope = jsonb_set(scope, '{eventIds}', ${next})
        WHERE organisation_id = $1 AND scope ->> 'exhibitorId' = $3
          AND accepted_at IS NULL AND revoked_at IS NULL ${only}`,
      [organisationId, eventId, exhibitorId],
    );
  }

  private async assertNameFree(
    em: EntityManager,
    organisationId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await em
      .getRepository(ExhibitorEntity)
      .createQueryBuilder('exhibitor')
      .where('exhibitor.organisationId = :organisationId', { organisationId })
      .andWhere('lower(exhibitor.name) = lower(:name)', { name })
      .andWhere(exceptId ? 'exhibitor.id <> :exceptId' : 'true', { exceptId })
      .getOne();
    if (clash) {
      throw new ConflictException(`There is already an exhibitor called "${clash.name}".`);
    }
  }
}
