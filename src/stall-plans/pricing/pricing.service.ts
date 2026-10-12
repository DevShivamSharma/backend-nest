import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { AuditService } from '../../audit/audit.service';
import type { Actor, OrgAccessContext } from '../../common/http/authenticated-request';
import type { EventEntity } from '../../events/event.entity';
import { EventsService } from '../../events/events.service';
import { PlanStallEntity, StallPlanEntity } from '../stall-plan.entity';
import { PriceCardDto, PriceRatesDto, SetStallPricesDto } from './pricing.dto';
import { StallPriceCardEntity, StallPriceEntity } from './pricing.entity';
import type { PlanPricingView } from './pricing.views';
import {
  forSale,
  PRICE_TYPES,
  PriceCard,
  PricedStall,
  PriceRates,
  stallPrice,
  StallPriceOverride,
} from './stall-price';

/** Stalls named in a refusal; the rest are counted. */
const NAMED = 5;

/**
 * Prices of an event hall's stalls: the rate card (ITPO's price master, one rate for now) and
 * prices set on single stalls. On an internal event the venue's team prices them, on an
 * external one the organiser, each with `pricing.manage`; `pricing.view` sees them. Prices are
 * not part of the venue's approval of an external plan, but a plan is sent only once every stall
 * for sale has a price.
 */
@Injectable()
export class PricingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  /** For the planner: null when this member may not see prices. */
  async view(
    access: OrgAccessContext,
    event: EventEntity,
    eventHallId: string,
    em: EntityManager = this.dataSource.manager,
  ): Promise<PlanPricingView | null> {
    if (!access.permissions.includes('pricing.view')) return null;
    const readOnlyReason = PricingService.readOnlyReason(access, event);
    return {
      card: await this.card(em, eventHallId),
      prices: (await em.getRepository(StallPriceEntity).findBy({ eventHallId })).map((p) => ({
        stallId: p.stallId,
        price: p.price,
        note: p.note,
      })),
      canManage: !readOnlyReason,
      readOnlyReason,
    };
  }

  async setCard(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: PriceCardDto,
    actor: Actor,
  ): Promise<PlanPricingView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanManage(access, event);
    EventsService.assertOpen(event);
    return this.dataSource.transaction(async (em) => {
      const cards = em.getRepository(StallPriceCardEntity);
      await cards.delete({ eventHallId: row.id });
      await cards.insert(
        PRICE_TYPES.filter((type) => dto[type]).map((type) => ({
          eventHallId: row.id,
          type,
          ...PricingService.rates(dto[type]!),
          updatedById: actor.id,
        })),
      );
      await this.audit.record(
        {
          action: 'pricing.card_set',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: { name: event.name, eventHallId: row.id, card: dto },
        },
        em,
      );
      return (await this.view(access, event, row.id, em))!;
    });
  }

  async setStallPrices(
    access: OrgAccessContext,
    id: string,
    hallId: string,
    dto: SetStallPricesDto,
    actor: Actor,
  ): Promise<PlanPricingView> {
    const { event, row } = await this.events.eventHallOf(access, id, hallId);
    this.assertCanManage(access, event);
    EventsService.assertOpen(event);
    return this.dataSource.transaction(async (em) => {
      const prices = em.getRepository(StallPriceEntity);
      const off = dto.prices.filter((p) => p.price === null || p.price === undefined);
      const on = dto.prices.filter((p) => p.price !== null && p.price !== undefined);
      if (off.length) {
        await prices.delete({ eventHallId: row.id, stallId: In(off.map((p) => p.stallId)) });
      }
      if (on.length) {
        await prices.upsert(
          on.map((p) => ({
            eventHallId: row.id,
            stallId: p.stallId,
            price: p.price!,
            note: p.note ?? null,
            updatedById: actor.id,
          })),
          ['eventHallId', 'stallId'],
        );
      }
      await this.audit.record(
        {
          action: 'pricing.stalls_set',
          actor,
          organisationId: access.organisation.id,
          targetType: 'event',
          targetId: event.id,
          metadata: {
            name: event.name,
            eventHallId: row.id,
            set: on.length,
            cleared: off.length,
            prices: dto.prices.slice(0, 50),
          },
        },
        em,
      );
      return (await this.view(access, event, row.id, em))!;
    });
  }

  /** Prices of stalls no longer on the saved plan go with them. */
  async dropMissing(em: EntityManager, eventHallId: string, stallIds: string[]): Promise<void> {
    const query = em
      .createQueryBuilder()
      .delete()
      .from(StallPriceEntity)
      .where('event_hall_id = :eventHallId', { eventHallId });
    if (stallIds.length) query.andWhere('stall_id NOT IN (:...ids)', { ids: stallIds });
    await query.execute();
  }

  /** What `stallPrice()` needs for an event hall: its rate card and the prices set on stalls. */
  async priceInputs(
    em: EntityManager,
    eventHallId: string,
  ): Promise<{ card: PriceCard | null; own: Map<string, StallPriceOverride> }> {
    const card = await this.card(em, eventHallId);
    const own = new Map(
      (await em.getRepository(StallPriceEntity).findBy({ eventHallId })).map(
        (p) => [p.stallId, { price: p.price, note: p.note }] as const,
      ),
    );
    return { card, own };
  }

  /**
   * The saved plan's stalls that are for sale and have no price; empty when every one has one.
   * Their numbers, as ITPO writes them.
   */
  async unpriced(em: EntityManager, plan: StallPlanEntity): Promise<string[]> {
    const card = await this.card(em, plan.eventHallId);
    const own = new Map(
      (await em.getRepository(StallPriceEntity).findBy({ eventHallId: plan.eventHallId })).map(
        (p) => [p.stallId, { price: p.price, note: p.note } as StallPriceOverride],
      ),
    );
    const stalls = await em.getRepository(PlanStallEntity).findBy({ planId: plan.id });
    return stalls
      .filter((s) => forSale(s) && !stallPrice(s as PricedStall, card, own.get(s.id)))
      .map((s) => `${s.islandNumber ?? ''}${s.stallNumber}`.trim());
  }

  /** "12 stalls for sale have no price: 11-01 A, …" */
  static unpricedMessage(numbers: string[]): string {
    const named = numbers.slice(0, NAMED).join(', ');
    const more = numbers.length - Math.min(numbers.length, NAMED);
    const count = `${numbers.length} ${numbers.length === 1 ? 'stall' : 'stalls'} for sale`;
    return `${count} ${numbers.length === 1 ? 'has' : 'have'} no price: ${named}${more ? ` and ${more} more` : ''}. Price ${numbers.length === 1 ? 'it' : 'them'} first.`;
  }

  /** Null when this member may price the event's stalls; else why not. */
  static readOnlyReason(access: OrgAccessContext, event: EventEntity): string | null {
    if (!access.permissions.includes('pricing.manage')) {
      return 'Your role can see prices but not set them.';
    }
    const organiser = EventsService.isOrganiser(access);
    if (event.kind === 'external' && !organiser) {
      return `${event.organiserName ?? 'The organiser'} prices the stalls of this external event.`;
    }
    if (event.kind === 'internal' && organiser) {
      return 'The venue’s own team prices the stalls of internal events.';
    }
    return null;
  }

  private assertCanManage(access: OrgAccessContext, event: EventEntity): void {
    const reason = PricingService.readOnlyReason(access, event);
    if (reason) throw new ForbiddenException(reason);
  }

  private async card(em: EntityManager, eventHallId: string): Promise<PriceCard | null> {
    const rows = await em.getRepository(StallPriceCardEntity).findBy({ eventHallId });
    const of = (type: string): PriceRates | null => {
      const r = rows.find((row) => row.type === type);
      return r
        ? {
            bareRate: r.bareRate,
            shellRate: r.shellRate,
            side2Percent: r.side2Percent,
            side3Percent: r.side3Percent,
            side4Percent: r.side4Percent,
            catalogueCharge: r.catalogueCharge,
            fnbPrice: r.fnbPrice,
          }
        : null;
    };
    const general = of('general');
    return general ? { general, premium: of('premium'), marquee: of('marquee') } : null;
  }

  private static rates(dto: PriceRatesDto): PriceRates {
    return {
      bareRate: dto.bareRate,
      shellRate: dto.shellRate,
      side2Percent: dto.side2Percent,
      side3Percent: dto.side3Percent,
      side4Percent: dto.side4Percent,
      catalogueCharge: dto.catalogueCharge,
      fnbPrice: dto.fnbPrice ?? null,
    };
  }
}
