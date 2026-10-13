import { createHmac } from 'node:crypto';

/**
 * `X-Platform-Signature`: "sha256=" + lowercase hex HMAC-SHA256(secret, "<timestamp>.<body>"),
 * over the exact body bytes sent. The timestamp is inside the signed text, so the venue can
 * refuse an old request (ITPO allows 300 s) and nobody can re-date a captured one.
 */
export function venueSignature(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `sha256=${digest}`;
}
