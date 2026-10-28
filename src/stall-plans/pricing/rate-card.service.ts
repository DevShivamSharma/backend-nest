import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../../audit/audit.service';
import type { SessionUser } from '../../auth/domain/session-user';
import type { PriceCard } from '../domain/pricing/stall-price';
import { SaveRateCardDto } from './pricing.dto';
import { PlanContextService } from '../services/plan-context.service';
import { StallPlansService } from '../services/stall-plans.service';
import { cardAt, periodProblems, RATE_TYPES, type RatePeriod } from './rate-card';

export interface RateCardView {
  periods: RatePeriod[];
  /** The rates as they stand today, per price type: what the planner prices stalls by. */
  card: PriceCard | null;
  canManage: boolean;
  readOnlyReason: string | null;
}

interface Row {
  id: string;
  applicable_to: string;
  start_date: Date;
  end_date: Date;
  bare_rate: string;
  shell_rate: string;
  two_side_open_rate_percent: string | null;
  three_side_open_rate_percent: string | null;
  four_side_open_rate_percent: string | null;
  catlog_entry_charge: string | null;
  fnb_price: string | null;
}

/**
 * An event hall's rate card, in ITPO's own `T_STALL_PRICE_MASTER`, the table SelfCare prices stall
 * bookings from: per price type (General, Premium, Marquee), rates per m² for bare space and shell
 * scheme, a percent more for 2, 3 and 4 open sides, the catalogue entry charge and a food and
 * beverage price, for each period of days. The portal keeps no copy.
 */
@Injectable()
export class RateCardService {
  constructor(
    private readonly db: DataSource,
    private readonly context: PlanContextService,
    private readonly plans: StallPlansService,
    private readonly audit: AuditService,
  ) {}

  async get(eventId: string, eventHallId: string, user: SessionUser): Promise<RateCardView> {
    await this.context.eventHall(eventId, eventHallId, user);
    const periods = await this.periods(this.db.manager, eventHallId);
    let canManage = true;
    let readOnlyReason: string | null = null;
    try {
      await this.plans.editableHall(eventId, eventHallId, user);
    } catch (e) {
      if (!(e instanceof ForbiddenException)) throw e;
      canManage = false;
      readOnlyReason = e.message;
    }
    return { periods, card: cardAt(periods, new Date()), canManage, readOnlyReason };
  }

  async save(
    eventId: string,
    eventHallId: string,
    dto: SaveRateCardDto,
    user: SessionUser,
  ): Promise<RateCardView> {
    const hall = await this.plans.editableHall(eventId, eventHallId, user);
    const problems = periodProblems(dto.periods);
    if (problems.length) throw new BadRequestException(problems.join(' '));

    await this.db.transaction(async (em) => {
      const existing = await this.periods(em, eventHallId, true);
      const known = new Set(existing.map((p) => p.id));
      const keep = new Set(dto.periods.flatMap((p) => (p.id ? [p.id] : [])));
      for (const id of keep) {
        if (!known.has(id))
          throw new BadRequestException('A rate period of this hall was not found.');
      }
      // Rows of the three types that are not in the list were taken out of it.
      const gone = existing.filter((p) => !keep.has(p.id!)).map((p) => p.id);
      if (gone.length) {
        await em.query(`DELETE FROM idp."T_STALL_PRICE_MASTER" WHERE id = ANY($1::uuid[])`, [gone]);
      }
      for (const p of dto.periods) {
        const values = [
          p.type,
          p.startAt,
          p.endAt,
          p.bareRate,
          p.shellRate,
          p.side2Percent,
          p.side3Percent,
          p.side4Percent,
          p.catalogueCharge,
          p.fnbPrice,
        ];
        if (p.id) {
          await em.query(
            `UPDATE idp."T_STALL_PRICE_MASTER"
                SET applicable_to = $2,
                    start_date = $3::timestamptz, end_date = $4::timestamptz,
                    bare_rate = $5, shell_rate = $6,
                    two_side_open_rate_percent = $7, three_side_open_rate_percent = $8,
                    four_side_open_rate_percent = $9, catlog_entry_charge = $10,
                    fnb_price = $11, kitchen_price = $11, status = 1, updated_at = NOW()
              WHERE id = $1`,
            [p.id, ...values],
          );
        } else {
          await em.query(
            `INSERT INTO idp."T_STALL_PRICE_MASTER"
               (id, hall_id, event_id, applicable_to, start_date, end_date, bare_rate, shell_rate,
                two_side_open_rate_percent, three_side_open_rate_percent, four_side_open_rate_percent,
                catlog_entry_charge, fnb_price, kitchen_price, status, corner_charges_applicable,
                is_fnb_stall, is_overseas_pricing)
             VALUES (gen_random_uuid(), $11, $12, $1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $10, 1, true, false, false)`,
            [...values, eventHallId, eventId],
          );
        }
      }
    });
    const event = await this.context.eventHall(eventId, eventHallId, user);
    await this.audit.record(user, {
      action: 'rates.saved',
      event: { id: eventId, name: event.eventName },
      hall: { id: eventHallId, name: hall.name },
      detail: `${dto.periods.length} period${dto.periods.length === 1 ? '' : 's'}`,
    });
    return this.get(eventId, eventHallId, user);
  }

  private async periods(
    em: EntityManager,
    eventHallId: string,
    lock = false,
  ): Promise<RatePeriod[]> {
    const rows = await em.query<Row[]>(
      `SELECT id, applicable_to, start_date, end_date, bare_rate, shell_rate, two_side_open_rate_percent, three_side_open_rate_percent,
              four_side_open_rate_percent, catlog_entry_charge, fnb_price
         FROM idp."T_STALL_PRICE_MASTER"
        WHERE hall_id = $1 AND status = 1 AND applicable_to = ANY($2::text[])
        ORDER BY applicable_to, start_date ${lock ? 'FOR UPDATE' : ''}`,
      [eventHallId, [...RATE_TYPES]],
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.applicable_to as RatePeriod['type'],
      startAt: new Date(r.start_date).toISOString(),
      endAt: new Date(r.end_date).toISOString(),
      bareRate: Number(r.bare_rate),
      shellRate: Number(r.shell_rate),
      side2Percent: Number(r.two_side_open_rate_percent ?? 0),
      side3Percent: Number(r.three_side_open_rate_percent ?? 0),
      side4Percent: Number(r.four_side_open_rate_percent ?? 0),
      catalogueCharge: Number(r.catlog_entry_charge ?? 0),
      fnbPrice: r.fnb_price === null ? null : Number(r.fnb_price),
    }));
  }
}
