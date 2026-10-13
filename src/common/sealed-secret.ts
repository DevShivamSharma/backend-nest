import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A secret the server must use again later in plain text (the venue's HMAC secret), kept in the
 * database encrypted with AES-256-GCM under INTEGRATION_SECRET_KEY. Tokens are hashed instead
 * (`crypto.ts`) because the server only ever compares them; an outbound signature needs the
 * secret itself, which a hash cannot give back.
 *
 * Stored as `v1:` + base64(iv ‖ tag ‖ ciphertext). The iv is random per seal (GCM must never
 * reuse one under a key). The tag makes a changed or truncated value fail to open instead of
 * opening to garbage. `context` (the organisation id) is authenticated but not stored, so a
 * sealed value copied onto another organisation's row does not open there.
 */
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function sealSecret(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

/** Throws when the value was sealed under another key or context, or was changed. */
export function openSecret(sealed: string, key: Buffer, context: string): string {
  const [version, encoded] = sealed.split(':', 2);
  if (version !== VERSION || !encoded) throw new Error('Unknown sealed-secret format.');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('The sealed secret is too short.');
  const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plain = Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
