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

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import {
  ChangeEventStatusDto,
  CreateEventDto,
  ListEventsQuery,
  UpdateEventDto,
} from './dto/event.dto';
import type { EventDetailView, EventView, HallOptionView } from './event.views';
import { EventsService } from './events.service';

/** Events and the halls they book (Module D). Seeing needs `events.view`; changes `events.manage`. */
@OrgAccess('events.view')
@Controller('orgs/:slug/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(
    @CurrentAccess() access: OrgAccessContext,
    @Query() query: ListEventsQuery,
  ): Promise<EventView[]> {
    return this.events.list(access, query);
  }

  @RequirePermissions('events.manage')
  @Post()
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEventDto,
  ): Promise<EventView> {
    return this.events.create(access, dto, user);
  }

  @Get(':eventId')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<EventDetailView> {
    return this.events.get(access, eventId);
  }

  @RequirePermissions('events.manage')
  @Patch(':eventId')
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: UpdateEventDto,
  ): Promise<EventView> {
    return this.events.update(access, eventId, dto, user);
  }

  @RequirePermissions('events.manage')
  @Post(':eventId/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: ChangeEventStatusDto,
  ): Promise<EventView> {
    return this.events.setStatus(access, eventId, dto, user);
  }

  @RequirePermissions('events.manage')
  @Delete(':eventId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<void> {
    return this.events.remove(access, eventId, user);
  }

  /** The venue's halls and which other events hold them on the event's days. */
  @RequirePermissions('events.manage')
  @Get(':eventId/hall-options')
  hallOptions(
    @CurrentAccess() access: OrgAccessContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<HallOptionView[]> {
    return this.events.hallOptions(access, eventId);
  }

  @RequirePermissions('events.manage')
  @Put(':eventId/halls/:hallId')
  addHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<EventDetailView> {
    return this.events.addHall(access, eventId, hallId, user);
  }

  @RequirePermissions('events.manage')
  @Delete(':eventId/halls/:hallId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<void> {
    return this.events.removeHall(access, eventId, hallId, user);
  }
}
