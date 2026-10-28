import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';

import type { SessionUser } from '../../auth/domain/session-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SaveRateCardDto } from './pricing.dto';
import { RateCardService, RateCardView } from './rate-card.service';

/** The rate card of an event hall. Who may read or change it follows the hall's plan. */
@Controller({ path: 'events/:eventId/halls/:eventHallId/pricing', version: '1' })
export class PricingController {
  constructor(private readonly cards: RateCardService) {}

  @Get()
  get(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<RateCardView> {
    return this.cards.get(eventId, eventHallId, user);
  }

  @Put()
  save(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: SaveRateCardDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RateCardView> {
    return this.cards.save(eventId, eventHallId, dto, user);
  }
}
