import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { AllowedUserTypes } from '../../auth/decorators/user-types.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  AddEventHallsDto,
  CreateInternalEventDto,
  UpdateEventHallDto,
  UpdateInternalEventDto,
} from '../dto/events.dto';
import { EventHall, EventsService, InternalEvent } from '../services/events.service';

/** Internal events: ITPO's own, set up by ITPO staff. */
@AllowedUserTypes(UserType.ItpoStaff)
@Controller({ path: 'events', version: '1' })
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post('internal')
  createInternal(
    @Body() dto: CreateInternalEventDto,
    @CurrentUser() user: SessionUser,
  ): Promise<InternalEvent> {
    return this.events.createInternal(dto, user);
  }

  /** Edits an internal event: any of its fields, including the visibility toggle. */
  @Patch(':eventId')
  update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: UpdateInternalEventDto,
    @CurrentUser() user: SessionUser,
  ): Promise<InternalEvent> {
    return this.events.updateInternal(eventId, dto, user);
  }

  @Post(':eventId/halls')
  addHalls(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: AddEventHallsDto,
  ): Promise<{ eventId: string; halls: EventHall[] }> {
    return this.events.addHalls(eventId, dto);
  }

  /** Edits a hall of the event, by its event-hall id (the `id` that adding it returned). */
  @Patch(':eventId/halls/:eventHallId')
  updateHall(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: UpdateEventHallDto,
  ): Promise<EventHall> {
    return this.events.updateHall(eventId, eventHallId, dto);
  }

  /** Takes a hall out of the event. */
  @Delete(':eventId/halls/:eventHallId')
  @HttpCode(200)
  async removeHall(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
  ): Promise<void> {
    await this.events.removeHall(eventId, eventHallId);
  }
}
