import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../common/decorators/public.decorator';
import { PublicEventsService } from './public-events.service';
import type { PublicEventView, PublicStallMapView } from './public-events.views';

/** Anyone with the link may look; a ceiling per client keeps scrapers from the database. */
const READ_LIMIT = { default: { limit: 60, ttl: 60_000 } };

/**
 * A read-only view of an event for sharing with exhibitors, before they have an account. Ids are
 * not parsed by a pipe: a malformed one is the same 404 as an unknown one.
 */
@Public()
@Controller('public/orgs/:slug/events/:eventId')
export class PublicEventsController {
  constructor(private readonly publicEvents: PublicEventsService) {}

  @Get()
  @Throttle(READ_LIMIT)
  event(@Param('slug') slug: string, @Param('eventId') eventId: string): Promise<PublicEventView> {
    return this.publicEvents.event(slug, eventId);
  }

  @Get('halls/:hallId/stalls')
  @Throttle(READ_LIMIT)
  stallMap(
    @Param('slug') slug: string,
    @Param('eventId') eventId: string,
    @Param('hallId') hallId: string,
  ): Promise<PublicStallMapView> {
    return this.publicEvents.stallMap(slug, eventId, hallId);
  }
}
