import { createHmac, timingSafeEqual } from 'node:crypto';

/** How old a signed report may be, either way, before it is refused as a possible replay. */
export const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/**
 * The signature a venue system puts on a status report: `sha256=` and the hex HMAC-SHA256 of
 * `<timestamp>.<raw body>` under the shared secret. The timestamp is Unix seconds.
 */
export function signVenueBody(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${mac}`;
}

/** Null when the report is genuine and fresh; otherwise why it is refused. */
export function signatureProblem(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer | undefined,
  now: Date = new Date(),
): string | null {
  if (!timestamp || !signature || !rawBody) return 'The report is not signed.';
  if (!/^\d{1,12}$/.test(timestamp)) return 'The report timestamp is not valid.';
  const age = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (age > SIGNATURE_WINDOW_SECONDS) return 'The report is too old or from the future.';
  const expected = Buffer.from(signVenueBody(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return 'The report signature does not match.';
  }
  return null;
}
