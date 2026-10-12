import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two hex digests; unequal lengths are simply unequal. */
function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checkout's success handler gives `razorpay_signature` = HMAC-SHA256(key_secret,
 * order_id + "|" + payment_id), hex. Proves the browser did not invent the payment id; it does
 * not prove the money was captured, so verify still fetches the payment.
 */
export function checkoutSignatureValid(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return sameHex(expected, signature);
}

/** `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, the raw request body), hex. */
export function webhookSignatureValid(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return sameHex(expected, signature);
}
