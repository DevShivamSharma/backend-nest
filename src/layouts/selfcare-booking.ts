import { moneyProduct } from '../pricing/money';

/**
 * A booking in the shape of the SelfCare (ITPO) portal's database, so it can be written there as
 * it is: every key below is a column of `idp."T_STALLS"`, `idp."T_STALL_BOOKING"` or
 * `idp."T_STALL_BOOKING_DETAIL"`, with the same name and the same values SelfCare stores.
 *
 * What SelfCare's own data shows (production dump):
 *  - A stall is `island_number` + `stall_number`: "12A-17" + "A" is our stall "12A-17 A".
 *  - Before payment a booking is `Pending` / payment `Pending`, its stall line `In-Progress`, the
 *    stall `In-Progress`, held until `valid_till` (about 60 minutes after creation). Payment turns
 *    them into `Confirmed` / `Completed` / `Booked` / `Booked`. This planner takes no payment, so
 *    its bookings are written in the pre-payment state.
 *  - rental = area × rate (shell_rate or bare_rate); corner_charge = rental × the 2/3/4-side open
 *    percent; total = rental + corner_charge + catalog_charge; GST is CGST + SGST (or IGST) on
 *    the total; net_payable_amount = total + GST.
 *
 * Ids SelfCare owns (user, event, its stall uuid, its hall number) and its prices come with the
 * request; without them those columns are null and no amount is computed. Nothing is invented.
 */

/** `T_STALL_PRICE_MASTER`, the columns used to price one stall. */
export interface SelfcarePricing {
  bare_rate: number | null;
  shell_rate: number | null;
  two_side_open_rate_percent: number | null;
  three_side_open_rate_percent: number | null;
  four_side_open_rate_percent: number | null;
  /** Spelled as in the SelfCare table. */
  catlog_entry_charge: number | null;
  corner_charges_applicable: boolean;
}

export interface SelfcareTax {
  cgst_percent: number | null;
  sgst_percent: number | null;
  igst_percent: number | null;
}

/** What the booking request may add: SelfCare's own ids, the stall type and its prices. */
export interface SelfcareBookingInput {
  expectedQuote?: string;
  user_id?: string | null;
  event_id?: string | null;
  event_name?: string | null;
  event_hall_id?: string | null;
  hall_id?: number | null;
  /** SelfCare's `T_STALLS.id` (uuid), when known. */
  stall_id?: string | null;
  stall_type?: 'shell' | 'bare' | null;
  product_category_id?: number | null;
  pricing?: SelfcarePricing | null;
  tax?: SelfcareTax | null;
}

/** The booked stall, as this planner stores it. */
export interface BookedStall {
  name: string;
  area: number;
  openSides: number;
}

export interface SelfcareBookingPayload {
  /** The `T_STALLS` row to update: by `id` when known, else by hall + island + stall number. */
  T_STALLS: {
    id: string | null;
    hall_id: number | null;
    island_number: string;
    stall_number: string | null;
    booking_status: 'In-Progress';
    no_of_open_sides: number;
  };
  /** The `T_STALL_BOOKING` row to insert; `id` and `booking_code` are SelfCare's to assign. */
  T_STALL_BOOKING: {
    user_id: string | null;
    event_id: string | null;
    event_name: string | null;
    status: 'active';
    booking_status: 'Pending';
    payment_status: 'Pending';
    valid_till: string;
    is_active: true;
    is_marquee: false;
    is_fnb_stall: false;
    is_branding_stall: false;
    is_horse_shoe: false;
    is_overseas_booking: false;
    created_at: string;
    updated_at: string;
  };
  /** The `T_STALL_BOOKING_DETAIL` rows to insert; `booking_id` is the new booking's id. */
  T_STALL_BOOKING_DETAIL: Array<{
    stall_id: string | null;
    hall_id: number | null;
    event_hall_id: string | null;
    event_id: string | null;
    user_id: string | null;
    product_category_id: number | null;
    stall_type: 'shell' | 'bare' | null;
    area: number;
    open_sides: number;
    rate: number | null;
    rental: number | null;
    corner_charge: number | null;
    catalog_charge: number | null;
    total: number | null;
    cgst_percent: number | null;
    cgst_amount: number | null;
    sgst_percent: number | null;
    sgst_amount: number | null;
    igst_percent: number | null;
    igst: number | null;
    total_gst_amount: number | null;
    net_payable_amount: number | null;
    status: 'In-Progress';
    valid_till: string;
    item_added_at: string;
    is_fnb_stall: false;
    is_branding_stall: false;
  }>;
}

/** How long SelfCare holds a stall before an unpaid booking times out. */
export const HOLD_MINUTES = 60;

export function selfcareBooking(
  stall: BookedStall,
  input: SelfcareBookingInput = {},
  now: Date = new Date(),
): SelfcareBookingPayload {
  const created = now.toISOString();
  const validTill = new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString();
  const { island, letter } = splitStallName(stall.name);
  const amounts = price(stall, input);
  const ids = {
    user_id: input.user_id ?? null,
    event_id: input.event_id ?? null,
  };

  return {
    T_STALLS: {
      id: input.stall_id ?? null,
      hall_id: input.hall_id ?? null,
      island_number: island,
      stall_number: letter,
      booking_status: 'In-Progress',
      no_of_open_sides: stall.openSides,
    },
    T_STALL_BOOKING: {
      ...ids,
      event_name: input.event_name ?? null,
      status: 'active',
      booking_status: 'Pending',
      payment_status: 'Pending',
      valid_till: validTill,
      is_active: true,
      is_marquee: false,
      is_fnb_stall: false,
      is_branding_stall: false,
      is_horse_shoe: false,
      is_overseas_booking: false,
      created_at: created,
      updated_at: created,
    },
    T_STALL_BOOKING_DETAIL: [
      {
        stall_id: input.stall_id ?? null,
        hall_id: input.hall_id ?? null,
        event_hall_id: input.event_hall_id ?? null,
        ...ids,
        product_category_id: input.product_category_id ?? null,
        stall_type: input.stall_type ?? null,
        area: stall.area,
        open_sides: stall.openSides,
        ...amounts,
        status: 'In-Progress',
        valid_till: validTill,
        item_added_at: created,
        is_fnb_stall: false,
        is_branding_stall: false,
      },
    ],
  };
}

/** "12A-17 A" -> island "12A-17", stall "A". A name without a trailing part is all island. */
export function splitStallName(name: string): { island: string; letter: string | null } {
  const match = /^(.+?)\s+([A-Za-z0-9]{1,4})$/.exec(name.trim());
  return match ? { island: match[1], letter: match[2] } : { island: name.trim(), letter: null };
}

type Amounts = Pick<
  SelfcareBookingPayload['T_STALL_BOOKING_DETAIL'][number],
  | 'rate' | 'rental' | 'corner_charge' | 'catalog_charge' | 'total'
  | 'cgst_percent' | 'cgst_amount' | 'sgst_percent' | 'sgst_amount' | 'igst_percent' | 'igst'
  | 'total_gst_amount' | 'net_payable_amount'
>;

/** SelfCare's price arithmetic. Every amount is null unless the stall type and its rate are given. */
function price(stall: BookedStall, input: SelfcareBookingInput): Amounts {
  const p = input.pricing;
  const tax = input.tax;
  const rate = p ? (input.stall_type === 'bare' ? p.bare_rate : input.stall_type === 'shell' ? p.shell_rate : null) : null;
  const cgstPercent = tax?.cgst_percent ?? null;
  const sgstPercent = tax?.sgst_percent ?? null;
  const igstPercent = tax?.igst_percent ?? null;
  if (rate === null || !p) {
    return {
      rate: null, rental: null, corner_charge: null, catalog_charge: null, total: null,
      cgst_percent: cgstPercent, cgst_amount: null, sgst_percent: sgstPercent, sgst_amount: null,
      igst_percent: igstPercent, igst: null, total_gst_amount: null, net_payable_amount: null,
    };
  }

  const rental = moneyProduct(stall.area, rate);
  const sidePercent =
    stall.openSides >= 4 ? p.four_side_open_rate_percent
      : stall.openSides === 3 ? p.three_side_open_rate_percent
        : stall.openSides === 2 ? p.two_side_open_rate_percent
          : 0;
  const cornerCharge = p.corner_charges_applicable ? moneyProduct(rental, sidePercent ?? 0, 100) : 0;
  const catalogCharge = money(p.catlog_entry_charge ?? 0);
  const total = money(rental + cornerCharge + catalogCharge);
  // Inter-state bookings carry IGST; otherwise CGST + SGST, as SelfCare stores them.
  const igst = igstPercent ? moneyProduct(total, igstPercent, 100) : 0;
  const cgst = igstPercent ? 0 : moneyProduct(total, cgstPercent ?? 0, 100);
  const sgst = igstPercent ? 0 : moneyProduct(total, sgstPercent ?? 0, 100);
  const gst = money(igst + cgst + sgst);

  return {
    rate, rental, corner_charge: cornerCharge, catalog_charge: catalogCharge, total,
    cgst_percent: cgstPercent, cgst_amount: cgst, sgst_percent: sgstPercent, sgst_amount: sgst,
    igst_percent: igstPercent, igst, total_gst_amount: gst, net_payable_amount: money(total + gst),
  };
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}
