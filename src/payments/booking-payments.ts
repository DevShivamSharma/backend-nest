import type { EntityManager } from 'typeorm';

/**
 * Payment changes that follow a booking change, as plain functions over the caller's
 * transaction, so `BookingsService` and `EventsService` use them without importing the payments
 * module (which imports theirs).
 */

/** A booking that leaves `held` or moves: its open order can no longer confirm it. */
export async function expireOpenPayments(em: EntityManager, bookingIds: string[]): Promise<void> {
  if (!bookingIds.length) return;
  await em.query(
    `UPDATE payments SET status = 'expired', updated_at = now()
      WHERE booking_id = ANY($1::uuid[]) AND status IN ('created', 'failed')`,
    [bookingIds],
  );
}

/** Requests a refund of whatever is left of each paid booking's payment; the worker sends them. */
export async function refundPaidInFull(
  em: EntityManager,
  bookingIds: string[],
  reason: string,
  actorId: string | null,
): Promise<
  Array<{ id: string; organisation_id: string; payment_id: string; amount_paise: number }>
> {
  if (!bookingIds.length) return [];
  return em.query(
    `WITH left_over AS (
       SELECT p.id, p.organisation_id,
              p.amount_paise - COALESCE((SELECT sum(r.amount_paise) FROM refunds r
                                          WHERE r.payment_id = p.id AND r.status <> 'failed'), 0) AS amount
         FROM payments p
        WHERE p.booking_id = ANY($1::uuid[]) AND p.status IN ('paid', 'partially_refunded'))
     INSERT INTO refunds (organisation_id, payment_id, amount_paise, status, reason, requested_by)
     SELECT organisation_id, id, amount, 'requested', $2, $3 FROM left_over WHERE amount > 0
     RETURNING id, organisation_id, payment_id, amount_paise`,
    [bookingIds, reason, actorId],
  );
}
