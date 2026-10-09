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
import { EventHallCategoryEntity, StallCategoryEntity } from '../categories/category.entity';
import { AuditService } from '../audit/audit.service';
import type { Actor, AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { RoleEntity, RoleScopeKind } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import { effectiveValues, RULE_IDS, RuleId, RULES, RuleSwitches } from '../rules/rule-catalogue';
import { RulesService } from '../rules/rules.service';
import { InvitationEntity } from '../team/invitation.entity';
import { InvitationsService } from '../team/invitations.service';
import { TeamService } from '../team/team.service';
import type { CreatedInvitationView } from '../team/team.views';
import { PlanSeatEntity, PlanStallEntity, StallPlanEntity } from '../stall-plans/stall-plan.entity';
import { HallEntity, HallFloorVersionEntity } from '../venues/hall.entity';
import { VenueEntity } from '../venues/venue.entity';
import {
  CreateEventDto,
  EventHallRulesDto,
  InviteEventPersonDto,
  UpdateEventDto,
} from './dto/events.dto';
import { EventEntity, EventHallEntity, EventKind } from './event.entity';
import type {
  EventDetailView,
  EventHallDetailView,
  EventHallView,
  EventPeopleView,
  EventView,
} from './event.views';

/** Most halls one event may use. */
const MAX_EVENT_HALLS = 100;

/**
 * Events (Module D): the organisation's events, the halls each uses and the rules for each
 * hall, and the organisers invited to an external event.
 *
 * A member with an event role (an organiser) sees only the events in their scope; everything
 * here goes through {@link EventsService.event} or {@link EventsService.visibleIds} for that.
 */
@Injectable()
export class EventsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rules: RulesService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
  ) {}

  // ---- events -------------------------------------------------------------------------------

  async list(access: OrgAccessContext, kind?: EventKind): Promise<EventView[]> {
    const visible = EventsService.visibleIds(access);
    if (visible?.length === 0) return [];
    const events = await this.dataSource.getRepository(EventEntity).find({
      where: {
        organisationId: access.organisation.id,
        ...(kind ? { kind } : {}),
        ...(visible ? { id: In(visible) } : {}),
      },
      order: { startsOn: 'DESC', name: 'ASC' },
    });
    const counts = await this.hallCounts(events.map((e) => e.id));
    return events.map((e) => EventsService.view(e, counts.get(e.id) ?? 0));
  }

  async get(access: OrgAccessContext, id: string): Promise<EventDetailView> {
    const em = this.dataSource.manager;
    const event = await this.event(em, access, id);
    const halls = await this.hallViews(em, event, !EventsService.isOrganiser(access));
    return { ...EventsService.view(event, halls.length), halls };
  }

  async create(organisationId: string, dto: CreateEventDto, actor: Actor): Promise<EventView> {
    const fields = EventsService.checked({
      ...dto,
      venueEventId: dto.venueEventId ?? null,
      organiserName: dto.organiserName ?? null,
      buildUpOn: dto.buildUpOn ?? null,
      dismantleOn: dto.dismantleOn ?? null,
    });
    const event = await this.dataSource.transaction(async (em) => {
      await this.assertVenueEventIdFree(em, organisationId, fields.venueEventId);
      const repo = em.getRepository(EventEntity);
      const saved = await repo.save(
        repo.create({ organisationId, ...fields, createdById: actor.id }),
      );
      await this.record(em, 'event.created', organisationId, saved, actor, {
        kind: saved.kind,
      });
      return saved;
    });
    return EventsService.view(event, 0);
  }

  async update(
    access: OrgAccessContext,
    id: string,
    dto: UpdateEventDto,
    actor: Actor,
  ): Promise<EventView> {
    const organisationId = access.organisation.id;
    const event = await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const next = EventsService.checked({
        kind: event.kind,
        name: dto.name ?? event.name,
        audience: dto.audience ?? event.audience,
        startsOn: dto.startsOn ?? event.startsOn,
        endsOn: dto.endsOn ?? event.endsOn,
        venueEventId: dto.venueEventId !== undefined ? dto.venueEventId : event.venueEventId,
        organiserName: dto.organiserName !== undefined ? dto.organiserName : event.organiserName,
        buildUpOn: dto.buildUpOn !== undefined ? dto.buildUpOn : event.buildUpOn,
        dismantleOn: dto.dismantleOn !== undefined ? dto.dismantleOn : event.dismantleOn,
      });
      if (next.venueEventId !== event.venueEventId) {
        await this.assertVenueEventIdFree(em, organisationId, next.venueEventId, event.id);
      }
      const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
        (k) => next[k] !== event[k],
      );
      Object.assign(event, next);
      const saved = await em.getRepository(EventEntity).save(event);
      if (changed.length) {
        await this.record(em, 'event.updated', organisationId, saved, actor, { changed });
      }
      return saved;
    });
    return EventsService.view(event, (await this.hallCounts([event.id])).get(event.id) ?? 0);
  }

  /** Deletes the event and its halls, and takes it out of every organiser's access. */
  async remove(access: OrgAccessContext, id: string, actor: Actor): Promise<void> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const people = await this.peopleOf(em, organisationId, event.id);
      for (const member of people.members) await this.dropFromMembership(em, member, event.id);
      for (const invitation of people.invitations) {
        await this.dropFromInvitation(em, invitation, event.id);
      }
      await em.getRepository(EventEntity).delete({ id: event.id });
      await this.record(em, 'event.deleted', organisationId, event, actor, {
        organisersRemoved: people.members.length,
      });
    });
  }

  // ---- halls --------------------------------------------------------------------------------

  /**
   * Adds halls to the event: each on its current floor version, with the organisation's rules
   * as they are now. Later changes to either do not reach the event.
   */
  async addHalls(
    access: OrgAccessContext,
    id: string,
    hallIds: string[],
    actor: Actor,
  ): Promise<EventDetailView> {
    const organisationId = access.organisation.id;
    const ids = [...new Set(hallIds)];
    const orgRules = await this.rules.get(organisationId);
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const halls = await em.getRepository(HallEntity).findBy({ id: In(ids), organisationId });
      if (halls.length !== ids.length) {
        throw new NotFoundException('Some of these halls are not in this organisation any more.');
      }
      const repo = em.getRepository(EventHallEntity);
      const existing = await repo.findBy({ eventId: event.id });
      const already = halls.filter((h) => existing.some((e) => e.hallId === h.id));
      if (already.length) {
        throw new ConflictException(
          `${already.map((h) => h.name).join(', ')} ${already.length === 1 ? 'is' : 'are'} already in this event.`,
        );
      }
      if (existing.length + halls.length > MAX_EVENT_HALLS) {
        throw new ConflictException(`An event uses at most ${MAX_EVENT_HALLS} halls.`);
      }
      await repo.save(
        halls.map((hall) =>
          repo.create({
            eventId: event.id,
            hallId: hall.id,
            floorVersion: hall.currentVersion,
            ruleSwitches: orgRules.switches,
            ruleValues: orgRules.values,
            drawingProfile: orgRules.drawingProfile,
          }),
        ),
      );
      await this.record(em, 'event.halls_added', organisationId, event, actor, {
        halls: halls.map((h) => h.name),
      });
    });
    return this.get(access, id);
  }

  async removeHall(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    actor: Actor,
  ): Promise<void> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const row = await this.eventHall(em, event.id, hallId);
      await em.getRepository(EventHallEntity).delete({ id: row.id });
      await this.record(em, 'event.hall_removed', organisationId, event, actor, {
        hall: row.hall?.name ?? null,
      });
    });
  }

  /** One hall of the event: its floor as drawn for the event, and the rules that apply. */
  async hall(access: OrgAccessContext, id: string, hallId: string): Promise<EventHallDetailView> {
    const em = this.dataSource.manager;
    const event = await this.event(em, access, id);
    const row = await this.eventHall(em, event.id, hallId);
    const floor = await em
      .getRepository(HallFloorVersionEntity)
      .findOneByOrFail({ hallId, version: row.floorVersion });
    const [view] = await this.hallViews(em, event, !EventsService.isOrganiser(access), [row]);
    return {
      event: { id: event.id, name: event.name, kind: event.kind, audience: event.audience },
      hall: view,
      floor: floor.floor,
      rules: EventsService.rulesView(row),
      categories: await EventsService.hallCategories(em, row.id),
      plan: await this.planCounts(em, row.id),
    };
  }

  /**
   * Sets the categories a hall of the event sells. New ones must be active; one that a stall
   * or seat of the hall's plan uses stays until the plan stops using it.
   */
  async setHallCategories(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    categoryIds: string[],
    actor: Actor,
  ): Promise<EventHallDetailView> {
    const organisationId = access.organisation.id;
    const wanted = [...new Set(categoryIds)];
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const row = await this.eventHall(em, event.id, hallId);
      const links = em.getRepository(EventHallCategoryEntity);
      const current = (await links.findBy({ eventHallId: row.id })).map((l) => l.categoryId);
      const categories = wanted.length
        ? await em.getRepository(StallCategoryEntity).findBy({ id: In(wanted), organisationId })
        : [];
      if (categories.length !== wanted.length) {
        throw new NotFoundException('Some of these categories are not in this organisation.');
      }
      const added = categories.filter((c) => !current.includes(c.id));
      const inactive = added.filter((c) => c.status !== 'active');
      if (inactive.length) {
        throw new BadRequestException(
          `${inactive.map((c) => c.name).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} inactive. Make ${inactive.length === 1 ? 'it' : 'them'} active first.`,
        );
      }
      const removed = current.filter((c) => !wanted.includes(c));
      if (removed.length) {
        const used = await this.categoriesInPlan(em, row.id, removed);
        if (used.length) {
          const names = await em.getRepository(StallCategoryEntity).findBy({ id: In(used) });
          throw new ConflictException(
            `Stalls or seats of this hall's plan use ${names.map((c) => c.name).join(', ')}. Change them in the planner first.`,
          );
        }
        await links.delete({ eventHallId: row.id, categoryId: In(removed) });
      }
      if (added.length) {
        await links.insert(added.map((c) => ({ eventHallId: row.id, categoryId: c.id })));
      }
      if (added.length || removed.length) {
        await this.record(em, 'event.hall_categories_changed', organisationId, event, actor, {
          hall: row.hall?.name ?? null,
          added: added.map((c) => c.name),
          removed: removed.length,
        });
      }
    });
    return this.hall(access, id, hallId);
  }

  /** The categories an event hall sells, by name. */
  static async hallCategories(
    em: EntityManager,
    eventHallId: string,
  ): Promise<EventHallDetailView['categories']> {
    const rows = await em
      .getRepository(StallCategoryEntity)
      .createQueryBuilder('c')
      .innerJoin(EventHallCategoryEntity, 'ehc', 'ehc.category_id = c.id')
      .where('ehc.event_hall_id = :eventHallId', { eventHallId })
      .orderBy('lower(c.name)', 'ASC')
      .getMany();
    return rows.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  }

  /** Which of these categories a stall or seat of the hall's plan uses. */
  private async categoriesInPlan(
    em: EntityManager,
    eventHallId: string,
    categoryIds: string[],
  ): Promise<string[]> {
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventHallId });
    if (!plan) return [];
    const stalls = await em
      .getRepository(PlanStallEntity)
      .createQueryBuilder('s')
      .select('DISTINCT unnest(s.category_ids)', 'id')
      .where('s.plan_id = :planId', { planId: plan.id })
      .getRawMany<{ id: string }>();
    const seats = await em
      .getRepository(PlanSeatEntity)
      .createQueryBuilder('s')
      .select('DISTINCT s.category_id', 'id')
      .where('s.plan_id = :planId AND s.category_id IS NOT NULL', { planId: plan.id })
      .getRawMany<{ id: string }>();
    const used = new Set([...stalls, ...seats].map((r) => r.id));
    return categoryIds.filter((c) => used.has(c));
  }

  private async planCounts(
    em: EntityManager,
    eventHallId: string,
  ): Promise<EventHallDetailView['plan']> {
    const plan = await em.getRepository(StallPlanEntity).findOneBy({ eventHallId });
    if (!plan) return { stalls: 0, seats: 0, revision: 0 };
    const stalls = await em.getRepository(PlanStallEntity).countBy({ planId: plan.id });
    const seats = await em.getRepository(PlanSeatEntity).countBy({ planId: plan.id });
    return { stalls, seats, revision: plan.revision };
  }

  /** Switches rules on or off for one hall of the event; the values stay as copied. */
  async updateHallRules(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: EventHallRulesDto,
    actor: Actor,
  ): Promise<EventHallDetailView> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const row = await this.eventHall(em, event.id, hallId);
      const next = EventsService.switches(dto.switches);
      const flipped = RULE_IDS.filter(
        (r) => (row.ruleSwitches[r] !== false) !== (next[r] !== false),
      );
      row.ruleSwitches = next;
      await em.getRepository(EventHallEntity).save(row);
      if (flipped.length) {
        await this.record(em, 'event.hall_rules_changed', organisationId, event, actor, {
          hall: row.hall?.name ?? null,
          switched: flipped,
        });
      }
    });
    return this.hall(access, id, hallId);
  }

  /** Copies the organisation's rules onto the hall again: switches, values and profile. */
  async resetHallRules(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    actor: Actor,
  ): Promise<EventHallDetailView> {
    const organisationId = access.organisation.id;
    const orgRules = await this.rules.get(organisationId);
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id, true);
      const row = await this.eventHall(em, event.id, hallId);
      row.ruleSwitches = orgRules.switches;
      row.ruleValues = orgRules.values;
      row.drawingProfile = orgRules.drawingProfile;
      await em.getRepository(EventHallEntity).save(row);
      await this.record(em, 'event.hall_rules_reset', organisationId, event, actor, {
        hall: row.hall?.name ?? null,
      });
    });
    return this.hall(access, id, hallId);
  }

  // ---- organisers ---------------------------------------------------------------------------

  /** Who has an organiser role on this event, and who is invited to one. */
  async people(access: OrgAccessContext, id: string): Promise<EventPeopleView> {
    const em = this.dataSource.manager;
    const event = await this.event(em, access, id);
    const { members, invitations } = await this.peopleOf(em, access.organisation.id, event.id);
    return {
      members: members.map(TeamService.view),
      invitations: invitations.map((i) => InvitationsService.view(i, i.role!, i.invitedBy ?? null)),
    };
  }

  /**
   * Gives a person an organiser role on this external event. Someone who already organises
   * other events here gets this one added; anyone else gets an invitation for it.
   */
  async invite(
    access: OrgAccessContext,
    id: string,
    dto: InviteEventPersonDto,
    user: AuthUser,
  ): Promise<{ added: boolean; invitation: CreatedInvitationView | null }> {
    const organisation = access.organisation;
    const em = this.dataSource.manager;
    const event = await this.event(em, access, id);
    if (event.kind !== 'external') {
      throw new BadRequestException(
        'Organisers are invited to external events. Internal events are drawn by your own team.',
      );
    }
    const role = await em.getRepository(RoleEntity).findOne({
      where: [
        { id: dto.roleId, organisationId: IsNull() },
        { id: dto.roleId, organisationId: organisation.id },
      ],
    });
    if (!role) throw new NotFoundException('Role not found.');
    const refusal = RolesService.grantCheck(access.permissions, role, true);
    if (refusal) throw new ForbiddenException(refusal);

    const member = await em
      .getRepository(MembershipEntity)
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.user', 'u')
      .innerJoinAndSelect('m.role', 'r')
      .where('m.organisationId = :org', { org: organisation.id })
      .andWhere('u.email = :email', { email: dto.email })
      .getOne();
    if (member) {
      await this.addToMembership(member, role, event, user);
      return { added: true, invitation: null };
    }

    // An open invitation for other events keeps them: this event joins its scope.
    const open = await em.getRepository(InvitationEntity).findOneBy({
      organisationId: organisation.id,
      email: dto.email,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
    });
    const eventIds = [...new Set([...(open?.scope.eventIds ?? []), event.id])];
    const { view } = await this.invitations.invite(
      organisation,
      { email: dto.email, roleId: role.id, scope: { eventIds } },
      { actor: user, permissions: access.permissions },
    );
    return { added: false, invitation: view };
  }

  /** Takes this event out of a member's access; with no event left, they leave. */
  async removePerson(
    access: OrgAccessContext,
    id: string,
    membershipId: string,
    actor: Actor,
  ): Promise<void> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id);
      const { members } = await this.peopleOf(em, organisationId, event.id);
      const member = members.find((m) => m.id === membershipId);
      if (!member) throw new NotFoundException('This person has no access to this event.');
      const left = await this.dropFromMembership(em, member, event.id);
      await this.record(em, 'event.person_removed', organisationId, event, actor, {
        email: member.user!.email,
        leftOrganisation: left,
      });
    });
  }

  async revokeInvitation(
    access: OrgAccessContext,
    id: string,
    invitationId: string,
    actor: Actor,
  ): Promise<void> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const event = await this.event(em, access, id);
      const { invitations } = await this.peopleOf(em, organisationId, event.id);
      const invitation = invitations.find((i) => i.id === invitationId);
      if (!invitation) throw new NotFoundException('There is no such invitation to this event.');
      await this.dropFromInvitation(em, invitation, event.id);
      await this.record(em, 'event.invitation_revoked', organisationId, event, actor, {
        email: invitation.email,
      });
    });
  }

  /** The event and its hall row, if this member may see the event. For the stall planner. */
  async eventHallOf(
    access: OrgAccessContext,
    id: string,
    hallId: string,
  ): Promise<{ event: EventEntity; row: EventHallEntity }> {
    const em = this.dataSource.manager;
    const event = await this.event(em, access, id);
    return { event, row: await this.eventHall(em, event.id, hallId) };
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Event ids an organiser may see; null for members who see every event. */
  static visibleIds(access: OrgAccessContext): string[] | null {
    return EventsService.isOrganiser(access) ? (access.membership.scope.eventIds ?? []) : null;
  }

  static isOrganiser(access: OrgAccessContext): boolean {
    return access.membership.role?.scopeKind === RoleScopeKind.Event;
  }

  /** The event, if this member may see it. Not found either way, so ids reveal nothing. */
  private async event(
    em: EntityManager,
    access: OrgAccessContext,
    id: string,
    lock = false,
  ): Promise<EventEntity> {
    const visible = EventsService.visibleIds(access);
    const event =
      visible && !visible.includes(id)
        ? null
        : await em.getRepository(EventEntity).findOne({
            where: { id, organisationId: access.organisation.id },
            ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
          });
    if (!event) throw new NotFoundException('There is no such event.');
    return event;
  }

  private async eventHall(
    em: EntityManager,
    eventId: string,
    hallId: string,
  ): Promise<EventHallEntity> {
    const row = await em
      .getRepository(EventHallEntity)
      .findOne({ where: { eventId, hallId }, relations: { hall: true } });
    if (!row) throw new NotFoundException('This hall is not in the event.');
    return row;
  }

  private async hallCounts(eventIds: string[]): Promise<Map<string, number>> {
    if (!eventIds.length) return new Map();
    const rows = await this.dataSource
      .getRepository(EventHallEntity)
      .createQueryBuilder('eh')
      .select('eh.eventId', 'eventId')
      .addSelect('COUNT(*)::int', 'count')
      .where('eh.eventId IN (:...eventIds)', { eventIds })
      .groupBy('eh.eventId')
      .getRawMany<{ eventId: string; count: number }>();
    return new Map(rows.map((r) => [r.eventId, r.count]));
  }

  /**
   * The event's halls with their venue and rules. `withOverlaps` lists other events on the same
   * hall at overlapping dates (build-up to dismantling); organisers never see other events.
   */
  private async hallViews(
    em: EntityManager,
    event: EventEntity,
    withOverlaps: boolean,
    only?: EventHallEntity[],
  ): Promise<EventHallView[]> {
    const rows =
      only ??
      (await em
        .getRepository(EventHallEntity)
        .find({ where: { eventId: event.id }, relations: { hall: true } }));
    if (!rows.length) return [];
    const venues = await em
      .getRepository(VenueEntity)
      .findBy({ id: In([...new Set(rows.map((r) => r.hall!.venueId))]) });
    const venueName = new Map(venues.map((v) => [v.id, v.name]));
    const overlaps = withOverlaps ? await this.overlaps(em, event, rows) : new Map();
    return rows
      .map((row) => {
        const hall = row.hall!;
        const rules = EventsService.rulesView(row);
        return {
          hallId: hall.id,
          name: hall.name,
          code: hall.code,
          level: hall.level,
          venue: { id: hall.venueId, name: venueName.get(hall.venueId) ?? '' },
          width: hall.width,
          depth: hall.depth,
          floorArea: hall.floorArea,
          floorVersion: row.floorVersion,
          latestFloorVersion: hall.currentVersion,
          // Rules waiting for data never run, whatever their switch says.
          rulesOn: RULES.filter((r) => r.available && rules.switches[r.id]).length,
          drawingProfile: row.drawingProfile,
          overlaps: overlaps.get(hall.id) ?? [],
        };
      })
      .sort((a, b) => a.venue.name.localeCompare(b.venue.name) || a.name.localeCompare(b.name));
  }

  private async overlaps(
    em: EntityManager,
    event: EventEntity,
    rows: EventHallEntity[],
  ): Promise<Map<string, EventHallView['overlaps']>> {
    const found = await em
      .getRepository(EventHallEntity)
      .createQueryBuilder('eh')
      .innerJoinAndSelect('eh.event', 'other')
      .where('eh.hallId IN (:...hallIds)', { hallIds: rows.map((r) => r.hallId) })
      .andWhere('other.id <> :id', { id: event.id })
      .andWhere('COALESCE(other.build_up_on, other.starts_on) <= :to', {
        to: event.dismantleOn ?? event.endsOn,
      })
      .andWhere('COALESCE(other.dismantle_on, other.ends_on) >= :from', {
        from: event.buildUpOn ?? event.startsOn,
      })
      .orderBy('other.startsOn', 'ASC')
      .getMany();
    const out = new Map<string, EventHallView['overlaps']>();
    for (const row of found) {
      const other = row.event!;
      const list = out.get(row.hallId) ?? [];
      list.push({
        eventId: other.id,
        name: other.name,
        startsOn: other.startsOn,
        endsOn: other.endsOn,
      });
      out.set(row.hallId, list);
    }
    return out;
  }

  /** Members with an event role on this event, and open invitations to it. */
  private async peopleOf(
    em: EntityManager,
    organisationId: string,
    eventId: string,
  ): Promise<{ members: MembershipEntity[]; invitations: InvitationEntity[] }> {
    const members = await em
      .getRepository(MembershipEntity)
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.user', 'u')
      .innerJoinAndSelect('m.role', 'r')
      .where('m.organisationId = :organisationId', { organisationId })
      .andWhere(`m.scope->'eventIds' ? :eventId`, { eventId })
      .orderBy('u.name', 'ASC')
      .getMany();
    const invitations = await em
      .getRepository(InvitationEntity)
      .createQueryBuilder('i')
      .innerJoinAndSelect('i.role', 'r')
      .leftJoinAndSelect('i.invitedBy', 'by')
      .where('i.organisationId = :organisationId', { organisationId })
      .andWhere('i.acceptedAt IS NULL AND i.revokedAt IS NULL')
      .andWhere(`i.scope->'eventIds' ? :eventId`, { eventId })
      .orderBy('i.createdAt', 'DESC')
      .getMany();
    return { members, invitations };
  }

  private async addToMembership(
    member: MembershipEntity,
    role: RoleEntity,
    event: EventEntity,
    actor: Actor,
  ): Promise<void> {
    const email = member.user!.email;
    if (member.role!.scopeKind !== RoleScopeKind.Event) {
      throw new ConflictException(`${email} is on your own team and already sees every event.`);
    }
    if (member.roleId !== role.id) {
      throw new ConflictException(
        `${email} is ${member.role!.name} for other events here. Give them that role for this event too.`,
      );
    }
    const eventIds = member.scope.eventIds ?? [];
    if (eventIds.includes(event.id)) {
      throw new ConflictException(`${email} already has access to this event.`);
    }
    await this.dataSource.transaction(async (em) => {
      await em
        .getRepository(MembershipEntity)
        .update(
          { id: member.id },
          { scope: { ...member.scope, eventIds: [...eventIds, event.id] } },
        );
      await this.record(em, 'event.person_added', event.organisationId, event, actor, {
        email,
        role: role.key,
      });
    });
  }

  /** Returns whether the member left the organisation (no event left in their scope). */
  private async dropFromMembership(
    em: EntityManager,
    member: MembershipEntity,
    eventId: string,
  ): Promise<boolean> {
    const eventIds = (member.scope.eventIds ?? []).filter((e) => e !== eventId);
    const repo = em.getRepository(MembershipEntity);
    if (!eventIds.length && member.role?.scopeKind === RoleScopeKind.Event) {
      await repo.delete({ id: member.id });
      return true;
    }
    await repo.update({ id: member.id }, { scope: { ...member.scope, eventIds } });
    return false;
  }

  private async dropFromInvitation(
    em: EntityManager,
    invitation: InvitationEntity,
    eventId: string,
  ): Promise<void> {
    const eventIds = (invitation.scope.eventIds ?? []).filter((e) => e !== eventId);
    await em
      .getRepository(InvitationEntity)
      .update(
        { id: invitation.id },
        eventIds.length ? { scope: { ...invitation.scope, eventIds } } : { revokedAt: new Date() },
      );
  }

  private async assertVenueEventIdFree(
    em: EntityManager,
    organisationId: string,
    venueEventId: string | null,
    exceptId?: string,
  ): Promise<void> {
    if (!venueEventId) return;
    const clash = await em.getRepository(EventEntity).findOneBy({ organisationId, venueEventId });
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(
        `"${clash.name}" already has the venue system's event id ${venueEventId}.`,
      );
    }
  }

  private record(
    em: EntityManager,
    action: string,
    organisationId: string,
    event: EventEntity,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor,
        organisationId,
        targetType: 'event',
        targetId: event.id,
        metadata: { name: event.name, ...metadata },
      },
      em,
    );
  }

  /** The fields of an event, checked together: real dates in order, an organiser if external. */
  private static checked(fields: {
    kind: EventKind;
    name: string;
    audience: EventEntity['audience'];
    startsOn: string;
    endsOn: string;
    venueEventId: string | null;
    organiserName: string | null;
    buildUpOn: string | null;
    dismantleOn: string | null;
  }) {
    const problems: string[] = [];
    for (const [label, value] of [
      ['Start', fields.startsOn],
      ['End', fields.endsOn],
      ['Build-up', fields.buildUpOn],
      ['Dismantling', fields.dismantleOn],
    ] as const) {
      if (value && !realDate(value)) problems.push(`${label} date ${value} is not a real date.`);
    }
    if (!problems.length) {
      if (fields.endsOn < fields.startsOn) problems.push('The event ends before it starts.');
      if (fields.buildUpOn && fields.buildUpOn > fields.startsOn) {
        problems.push('Build-up starts on or before the first day of the event.');
      }
      if (fields.dismantleOn && fields.dismantleOn < fields.endsOn) {
        problems.push('Dismantling ends on or after the last day of the event.');
      }
    }
    if (fields.kind === 'external' && !fields.organiserName) {
      problems.push('Name the organiser of an external event.');
    }
    if (problems.length) throw new BadRequestException(problems.join(' '));
    return {
      ...fields,
      organiserName: fields.kind === 'external' ? fields.organiserName : null,
    };
  }

  private static switches(input: Record<string, boolean>): RuleSwitches {
    const out: RuleSwitches = {};
    for (const [key, on] of Object.entries(input)) {
      if (!(RULE_IDS as readonly string[]).includes(key)) {
        throw new BadRequestException(`"${key}" is not a rule.`);
      }
      if (typeof on !== 'boolean')
        throw new BadRequestException(`Switch "${key}" must be on or off.`);
      out[key as RuleId] = on;
    }
    return out;
  }

  private static rulesView(row: EventHallEntity) {
    return {
      switches: Object.fromEntries(
        RULE_IDS.map((r) => [r, row.ruleSwitches?.[r] !== false]),
      ) as Record<RuleId, boolean>,
      values: effectiveValues(row.ruleValues),
      drawingProfile: row.drawingProfile,
    };
  }

  static view(event: EventEntity, hallCount: number): EventView {
    return {
      id: event.id,
      kind: event.kind,
      name: event.name,
      venueEventId: event.venueEventId,
      organiserName: event.organiserName,
      audience: event.audience,
      startsOn: event.startsOn,
      endsOn: event.endsOn,
      buildUpOn: event.buildUpOn,
      dismantleOn: event.dismantleOn,
      hallCount,
      updatedAt: event.updatedAt.toISOString(),
    };
  }
}

/** `YYYY-MM-DD` naming a day that exists (no 31 June). */
function realDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
