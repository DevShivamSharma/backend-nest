import { createHash, randomBytes } from 'node:crypto';

/** A URL-safe random token with 256 bits of entropy. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores instead of a token. Tokens are random and long, so a fast hash is
 * enough: there is nothing to brute-force, unlike a password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
