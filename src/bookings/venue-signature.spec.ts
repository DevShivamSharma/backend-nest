import { ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { SIGNATURE_WINDOW_SECONDS, signatureProblem, signVenueBody } from './venue-signature';
import { VenueSignatureGuard } from './venue-signature.guard';

const SECRET = 'venue-secret-venue-secret-venue-secret';
const NOW = new Date('2026-10-08T10:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = Buffer.from('{"deliveryId":"d-1","bookingId":"b-1"}');

describe('venue signature', () => {
  const signed = signVenueBody(SECRET, TS, BODY);

  it('accepts a genuine, fresh report', () => {
    expect(signed).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signatureProblem(SECRET, TS, signed, BODY, NOW)).toBeNull();
    // Within the window either way.
    const edge = String(Number(TS) - SIGNATURE_WINDOW_SECONDS);
    expect(signatureProblem(SECRET, edge, signVenueBody(SECRET, edge, BODY), BODY, NOW)).toBeNull();
  });

  it('refuses a report signed with another secret', () => {
    const forged = signVenueBody('another-secret-another-secret-another', TS, BODY);
    expect(signatureProblem(SECRET, TS, forged, BODY, NOW)).toMatch(/does not match/);
  });

  it('refuses a body changed after signing', () => {
    const tampered = Buffer.from('{"deliveryId":"d-1","bookingId":"b-2"}');
    expect(signatureProblem(SECRET, TS, signed, tampered, NOW)).toMatch(/does not match/);
    expect(signatureProblem(SECRET, TS, `${signed}0`, BODY, NOW)).toMatch(/does not match/);
  });

  it('refuses a stale report and one from the future', () => {
    const stale = String(Number(TS) - SIGNATURE_WINDOW_SECONDS - 1);
    const future = String(Number(TS) + SIGNATURE_WINDOW_SECONDS + 1);
    expect(signatureProblem(SECRET, stale, signVenueBody(SECRET, stale, BODY), BODY, NOW)).toMatch(
      /too old or from the future/,
    );
    expect(
      signatureProblem(SECRET, future, signVenueBody(SECRET, future, BODY), BODY, NOW),
    ).toMatch(/too old or from the future/);
  });

  it('refuses a report without its headers or body', () => {
    expect(signatureProblem(SECRET, undefined, signed, BODY, NOW)).toMatch(/not signed/);
    expect(signatureProblem(SECRET, TS, undefined, BODY, NOW)).toMatch(/not signed/);
    expect(signatureProblem(SECRET, TS, signed, undefined, NOW)).toMatch(/not signed/);
  });

  it('refuses a timestamp that is not Unix seconds', () => {
    for (const ts of ['soon', '1.5e9', '-1', `${TS}000000`]) {
      expect(signatureProblem(SECRET, ts, signVenueBody(SECRET, ts, BODY), BODY, NOW)).toMatch(
        /timestamp is not valid/,
      );
    }
  });
});

describe('VenueSignatureGuard', () => {
  const guard = (secret: string | null) =>
    new VenueSignatureGuard({
      getOrThrow: () => ({ venueWebhookSecret: secret }),
    } as unknown as ConfigService);

  function context(headers: Record<string, string>, rawBody?: Buffer): ExecutionContext {
    const request = { get: (name: string) => headers[name.toLowerCase()], rawBody };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  // The guard checks against the real clock.
  const now = () => String(Math.floor(Date.now() / 1000));

  it('answers 404 while no secret is configured, as if the route did not exist', () => {
    const ts = now();
    const ctx = context(
      { 'x-venue-timestamp': ts, 'x-venue-signature': signVenueBody(SECRET, ts, BODY) },
      BODY,
    );
    expect(() => guard(null).canActivate(ctx)).toThrow(NotFoundException);
  });

  it('answers 401 with the reason for a missing or wrong signature', () => {
    const ts = now();
    expect(() => guard(SECRET).canActivate(context({}, BODY))).toThrow(UnauthorizedException);
    const wrong = context(
      { 'x-venue-timestamp': ts, 'x-venue-signature': signVenueBody('x'.repeat(32), ts, BODY) },
      BODY,
    );
    expect(() => guard(SECRET).canActivate(wrong)).toThrow(/does not match/);
  });

  it('lets a genuine report through', () => {
    const ts = now();
    const ctx = context(
      { 'x-venue-timestamp': ts, 'x-venue-signature': signVenueBody(SECRET, ts, BODY) },
      BODY,
    );
    expect(guard(SECRET).canActivate(ctx)).toBe(true);
  });
});
