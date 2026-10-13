import { Logger } from '@nestjs/common';

import { venueSignature } from './venue-signature';

export const VENUE_TRANSPORT = Symbol('VENUE_TRANSPORT');

export interface VenueRequest {
  url: string;
  deliveryId: string;
  /** The stored payload text, sent byte for byte. */
  body: string;
  /** Plain text only for the moment of signing. Never logged. */
  secret: string;
}

/** What came back. `status` null: no answer (network, TLS, timeout). */
export interface VenueAnswer {
  status: number | null;
  /** The venue's error `code` and `message` (contract §6), when its body had them. */
  code: string | null;
  message: string | null;
  /** True from the log transport: nothing was sent. */
  logged?: boolean;
}

export interface VenueTransport {
  send(request: VenueRequest): Promise<VenueAnswer>;
}

export type DeliveryOutcome = 'delivered' | 'refused' | 'retry';

/**
 * 2xx: SelfCare has it. 5xx, 408, 429 and no answer are temporary: the same delivery is sent
 * again later. 400, 401, 404, 409 and 422 are the contract's refusals (§6) and any other answer
 * (another 4xx, a redirect we do not follow) would be the same next time: retrying cannot help.
 */
export function classifyAnswer(status: number | null): DeliveryOutcome {
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 500 || status === 408 || status === 429) return 'retry';
  return 'refused';
}

/** The venue's JSON error body, `{ code, message, details }`, cut to what the row keeps. */
export function venueError(text: string): { code: string | null; message: string | null } {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim().slice(0, 64) || null : null;
    const message =
      typeof body.message === 'string' ? body.message.trim().slice(0, 400) || null : null;
    if (code || message) return { code, message };
  } catch {
    // Not JSON: a proxy's page, say. Its first words are still a clue.
  }
  return { code: null, message: text.trim().slice(0, 200) || null };
}

/** The sentence a person sees for a refusal or a failed attempt. */
export function answerText(answer: VenueAnswer): string {
  const { status, code, message } = answer;
  if (status === null) return message ?? 'The venue system did not answer.';
  if (status === 401) {
    return 'SelfCare refused the signature (401): check the shared secret and both servers’ clocks.';
  }
  if (status >= 300 && status < 400) {
    return `The venue system answered with a redirect (${status}); set its final URL.`;
  }
  const said = [code, message].filter(Boolean).join(': ');
  return said ? `${said} (${status})` : `The venue system answered ${status}.`;
}

/** Sends nothing: writes the request, without the secret or signature, to the server log. */
export class LogVenueTransport implements VenueTransport {
  private readonly logger = new Logger('VenueSystem');

  async send(request: VenueRequest): Promise<VenueAnswer> {
    this.logger.log(
      `[log transport] POST ${request.url}\n` +
        `X-Platform-Delivery: ${request.deliveryId}\nX-Platform-Event: plan.published\n` +
        `X-Platform-Signature: (not shown)\n\n${request.body}`,
    );
    return { status: null, code: null, message: null, logged: true };
  }
}

export class HttpVenueTransport implements VenueTransport {
  constructor(private readonly timeoutMs: number) {}

  async send(request: VenueRequest): Promise<VenueAnswer> {
    const timestamp = Math.floor(Date.now() / 1000);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-delivery': request.deliveryId,
          'x-platform-timestamp': String(timestamp),
          'x-platform-event': 'plan.published',
          'x-platform-signature': venueSignature(request.secret, timestamp, request.body),
        },
        body: request.body,
        // A redirect would carry the signed body to an address nobody configured.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        status: null,
        code: null,
        message: timedOut
          ? `No answer within ${this.timeoutMs / 1000} s.`
          : `Could not reach the venue system (${error instanceof Error ? error.message : 'network error'}).`,
      };
    }
    // The same timeout covers reading the body; a body cut short is read as empty.
    const text = await response.text().catch(() => '');
    return { status: response.status, ...venueError(text) };
  }
}
