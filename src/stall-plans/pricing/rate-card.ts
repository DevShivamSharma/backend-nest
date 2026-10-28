import type { PriceCard, PriceRates, PriceType } from '../domain/pricing/stall-price';

/** The price types a portal user sets (SelfCare's "General New" rows are left as they are). */
export const RATE_TYPES = ['General', 'Premium', 'Marquee'] as const;
export type RateType = (typeof RATE_TYPES)[number];

/**
 * One row of ITPO's rate card (`T_STALL_PRICE_MASTER`): the rates a price type has for a stretch
 * of time, as SelfCare keeps them (early-bird and late rates are periods of one type). The ends
 * are instants (ISO 8601): SelfCare's own rows end and begin at any time of day, so they are kept
 * as they are, and a day picked in the portal runs from 00:00:00 to 23:59:59 India time.
 */
export interface RatePeriod {
  id?: string;
  type: RateType;
  startAt: string;
  endAt: string;
  bareRate: number;
  shellRate: number;
  side2Percent: number;
  side3Percent: number;
  side4Percent: number;
  catalogueCharge: number;
  fnbPrice: number | null;
}

const TYPE_KEY: Record<RateType, PriceType> = {
  General: 'general',
  Premium: 'premium',
  Marquee: 'marquee',
};

const ms = (iso: string) => Date.parse(iso);

/** What is wrong with a set of periods, one sentence each; empty when they can be saved. */
export function periodProblems(periods: readonly RatePeriod[]): string[] {
  const out: string[] = [];
  if (!periods.some((p) => p.type === 'General')) {
    out.push('Add the General rates: they price every stall that is not Premium or Marquee.');
  }
  for (const type of RATE_TYPES) {
    const own = periods
      .filter((p) => p.type === type)
      .sort((a, b) => ms(a.startAt) - ms(b.startAt));
    own.forEach((p, i) => {
      if (!Number.isFinite(ms(p.startAt)) || !Number.isFinite(ms(p.endAt))) {
        out.push(`${type}: a period has a date that is not a date.`);
      } else if (ms(p.endAt) < ms(p.startAt)) {
        out.push(`${type}: a period ends before it starts.`);
      } else if (i > 0 && ms(p.startAt) <= ms(own[i - 1].endAt)) {
        out.push(`${type}: two periods overlap.`);
      }
    });
  }
  return out;
}

/**
 * The rate card as it stands at `now`: for each type, the period that includes it; else the next
 * one to begin; else the last one that ended. Null without General.
 */
export function cardAt(periods: readonly RatePeriod[], now: Date): PriceCard | null {
  const t = now.getTime();
  const rates = (type: RateType): PriceRates | null => {
    const own = periods.filter((p) => p.type === type);
    const pick =
      own.find((p) => ms(p.startAt) <= t && t <= ms(p.endAt)) ??
      [...own].filter((p) => ms(p.startAt) > t).sort((a, b) => ms(a.startAt) - ms(b.startAt))[0] ??
      [...own].sort((a, b) => ms(b.endAt) - ms(a.endAt))[0];
    return pick
      ? {
          bareRate: pick.bareRate,
          shellRate: pick.shellRate,
          side2Percent: pick.side2Percent,
          side3Percent: pick.side3Percent,
          side4Percent: pick.side4Percent,
          catalogueCharge: pick.catalogueCharge,
          fnbPrice: pick.fnbPrice,
        }
      : null;
  };
  const general = rates('General');
  if (!general) return null;
  return { general, premium: rates('Premium'), marquee: rates('Marquee') };
}

export { TYPE_KEY };
