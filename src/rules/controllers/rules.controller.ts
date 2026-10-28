import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Put,
} from '@nestjs/common';

import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { AllowedUserTypes } from '../../auth/decorators/user-types.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SetEventRulesDto, UpdateRulesDto } from '../dto/rules.dto';
import { EventRulesView, HallRulesView, RulesService, RulesView } from '../services/rules.service';

/** The planning rules: one set for every hall, changed by ITPO staff. */
@Controller({ path: 'rules', version: '1' })
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  /** The rules that can be checked, the limits on their values, and the drawing profiles. */
  @Get('catalogue')
  catalogue(): ReturnType<RulesService['catalogue']> {
    return this.rules.catalogue();
  }

  /** Which rules are on, their values, documents and drawing profile. */
  @Get()
  get(): Promise<RulesView> {
    return this.rules.get();
  }

  @AllowedUserTypes(UserType.ItpoStaff)
  @Patch()
  update(@Body() dto: UpdateRulesDto, @CurrentUser() user: SessionUser): Promise<RulesView> {
    return this.rules.update(dto, user);
  }
}

/** An event's own rule switches, on top of the set. */
@Controller({ path: 'events/:eventId/rules', version: '1' })
export class EventRulesController {
  constructor(private readonly rules: RulesService) {}

  /** The rules as this event has them. ITPO staff see any event; an organiser, their own. */
  @Get()
  get(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<EventRulesView> {
    return this.rules.forEvent(eventId, user);
  }

  /** ITPO staff switch rules off or on for an event, internal or external. */
  @AllowedUserTypes(UserType.ItpoStaff)
  @Put()
  set(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: SetEventRulesDto,
    @CurrentUser() user: SessionUser,
  ): Promise<EventRulesView> {
    return this.rules.setForEvent(eventId, dto, user);
  }
}

/** A hall's own rule switches, on top of the default set. */
@Controller({ path: 'halls/:hallId/rules', version: '1' })
export class HallRulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  get(@Param('hallId', ParseIntPipe) hallId: number): Promise<HallRulesView> {
    return this.rules.forHall(hallId);
  }

  /** ITPO staff switch rules off or on for one hall. */
  @AllowedUserTypes(UserType.ItpoStaff)
  @Put()
  set(
    @Param('hallId', ParseIntPipe) hallId: number,
    @Body() dto: SetEventRulesDto,
    @CurrentUser() user: SessionUser,
  ): Promise<HallRulesView> {
    return this.rules.setForHall(hallId, dto, user);
  }
}
