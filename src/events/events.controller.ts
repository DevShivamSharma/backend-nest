import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import type { CreatedInvitationView } from '../team/team.views';
import {
  AddEventHallsDto,
  CreateEventDto,
  EventHallCategoriesDto,
  EventHallRulesDto,
  InviteEventPersonDto,
  UpdateEventDto,
} from './dto/events.dto';
import { EVENT_KINDS, EventKind } from './event.entity';
import type {
  EventDetailView,
  EventHallDetailView,
  EventPeopleView,
  EventView,
} from './event.views';
import { EventsService } from './events.service';

/**
 * Events (Module D). Seeing needs `events.view`; changes need `events.manage`. Organisers
 * (event roles) may use these routes, and see only their own events.
 */
@OrgAccess('events.view')
@AllowEventRoles()
@Controller('orgs/:slug/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(
    @CurrentAccess() access: OrgAccessContext,
    @Query('kind') kind?: string,
  ): Promise<EventView[]> {
    const known = (EVENT_KINDS as readonly string[]).includes(kind ?? '');
    return this.events.list(access, known ? (kind as EventKind) : undefined);
  }

  @RequirePermissions('events.manage')
  @Post()
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEventDto,
  ): Promise<EventView> {
    return this.events.create(access.organisation.id, dto, user);
  }

  @Get(':id')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EventDetailView> {
    return this.events.get(access, id);
  }

  @RequirePermissions('events.manage')
  @Patch(':id')
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ): Promise<EventView> {
    return this.events.update(access, id, dto, user);
  }

  @RequirePermissions('events.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.events.remove(access, id, user);
  }

  // ---- halls --------------------------------------------------------------------------------

  @RequirePermissions('events.manage')
  @Post(':id/halls')
  addHalls(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddEventHallsDto,
  ): Promise<EventDetailView> {
    return this.events.addHalls(access, id, dto.hallIds, user);
  }

  @Get(':id/halls/:hallId')
  hall(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<EventHallDetailView> {
    return this.events.hall(access, id, hallId);
  }

  @RequirePermissions('events.manage')
  @Delete(':id/halls/:hallId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<void> {
    return this.events.removeHall(access, id, hallId, user);
  }

  @RequirePermissions('events.manage')
  @Patch(':id/halls/:hallId/rules')
  updateHallRules(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: EventHallRulesDto,
  ): Promise<EventHallDetailView> {
    return this.events.updateHallRules(access, id, hallId, dto, user);
  }

  @RequirePermissions('events.manage')
  @Post(':id/halls/:hallId/rules/reset')
  @HttpCode(HttpStatus.OK)
  resetHallRules(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<EventHallDetailView> {
    return this.events.resetHallRules(access, id, hallId, user);
  }

  @RequirePermissions('events.manage')
  @Put(':id/halls/:hallId/categories')
  setHallCategories(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: EventHallCategoriesDto,
  ): Promise<EventHallDetailView> {
    return this.events.setHallCategories(access, id, hallId, dto.categoryIds, user);
  }

  // ---- organisers ---------------------------------------------------------------------------

  @RequirePermissions('events.manage')
  @Get(':id/people')
  people(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EventPeopleView> {
    return this.events.people(access, id);
  }

  @RequirePermissions('events.manage')
  @Post(':id/people')
  invite(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteEventPersonDto,
  ): Promise<{ added: boolean; invitation: CreatedInvitationView | null }> {
    return this.events.invite(access, id, dto, user);
  }

  @RequirePermissions('events.manage')
  @Delete(':id/people/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removePerson(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    return this.events.removePerson(access, id, membershipId, user);
  }

  @RequirePermissions('events.manage')
  @Delete(':id/invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvitation(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    return this.events.revokeInvitation(access, id, invitationId, user);
  }
}
