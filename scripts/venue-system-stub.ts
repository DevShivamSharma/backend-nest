import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A stand-in for ITPO SelfCare's stall-layout endpoint, for trying the plan push locally. It
 * follows docs/itpo-stall-push-endpoint-prompt.md on its own: it imports nothing from `src`, so
 * it checks our sender against an independent reading of the contract. It applies nothing; it
 * checks, remembers and answers. Never prints the secret or the signature.
 *
 *   VENUE_STUB_SECRET=<the secret set in the admin card> & $node -r ts-node/register scripts/venue-system-stub.ts
 *   callback URL: http://localhost:4500/api/integrations/venue-platform/stall-layouts
 *   create ./.venue-stub-has-bookings (or set VENUE_STUB_HAS_BOOKINGS=1) to get 409 EVENT_HALL_HAS_BOOKINGS
 *
 * VENUE_STUB_PORT changes the port (default 4500).
 */

const PATH = '/api/integrations/venue-platform/stall-layouts';
const PORT = Number(process.env.VENUE_STUB_PORT ?? 4500);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SKEW_SECONDS = 300;
const BOOKINGS_FLAG = './.venue-stub-has-bookings';

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** Every answer, by delivery id: a retry gets the same one. */
const answers = new Map<string, Answer>();
/** The last applied revision, by `itpoBookingId` + `itpoHallId`. */
const applied = new Map<string, number>();

function signatureValid(secret: string, timestamp: string, raw: Buffer, given: string): boolean {
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(given, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function refusal(status: number, code: string, message: string, details: object = {}): Answer {
  return { status, body: { code, message, details } };
}

function send(res: ServerResponse, answer: Answer): void {
  res.writeHead(answer.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer.body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Reads the raw body; null when it is over the cap. */
async function rawBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The contract's §5.1 checks; empty when the body is good. */
function bodyProblems(body: unknown, deliveryHeader: string): string[] {
  const problems: string[] = [];
  if (!isObject(body)) return ['The body is not a JSON object.'];
  if (body.schemaVersion !== 1) problems.push('schemaVersion must be 1.');
  if (body.kind !== 'plan.published') problems.push("kind must be 'plan.published'.");
  if (body.deliveryId !== deliveryHeader) {
    problems.push('deliveryId differs from the X-Platform-Delivery header.');
  }
  if (!isText(body.sentAt)) problems.push('sentAt is missing.');
  const event = body.event;
  if (!isObject(event) || !isText(event.itpoBookingId) || !isText(event.platformEventId)) {
    problems.push('event.itpoBookingId and event.platformEventId are required.');
  }
  const hall = body.hall;
  if (!isObject(hall) || !isNumber(hall.itpoHallId) || !isText(hall.platformHallId)) {
    problems.push('hall.itpoHallId (a number) and hall.platformHallId are required.');
  }
  const plan = body.plan;
  if (!isObject(plan) || !isNumber(plan.revision) || !Array.isArray(plan.stalls)) {
    problems.push('plan.revision (a number) and plan.stalls (a list) are required.');
    return problems;
  }
  if (!isText(plan.publishedAt)) problems.push('plan.publishedAt is missing.');
  if (plan.pxPerMetre !== 20) problems.push('plan.pxPerMetre must be 20.');
  const seen = new Set<string>();
  plan.stalls.forEach((stall: unknown, index: number) => {
    const at = `stalls[${index}]`;
    if (!isObject(stall)) {
      problems.push(`${at} is not an object.`);
      return;
    }
    if (!isText(stall.platformStallId)) problems.push(`${at}.platformStallId is missing.`);
    if (typeof stall.island_number !== 'string') problems.push(`${at}.island_number is missing.`);
    if (!isText(stall.stall_number)) problems.push(`${at}.stall_number is missing.`);
    const key = `${String(stall.island_number)}|${String(stall.stall_number)}`;
    if (seen.has(key)) problems.push(`${at}: island + stall number ${key} is repeated.`);
    seen.add(key);
    const box = stall.stall_coordinates;
    if (!isObject(box)) {
      problems.push(`${at}.stall_coordinates is missing.`);
    } else {
      for (const k of ['top', 'left', 'width', 'height', 'centerX', 'centerY']) {
        if (!isNumber(box[k])) problems.push(`${at}.stall_coordinates.${k} is not a finite number.`);
      }
    }
    const grid = stall.layout_grid;
    if (!isObject(grid) || !isText(grid.area) || !Array.isArray(grid.stallCoords)) {
      problems.push(`${at}.layout_grid is missing.`);
    } else if (!grid.stallCoords.every((p: unknown) => isObject(p) && isNumber(p.x) && isNumber(p.y))) {
      problems.push(`${at}.layout_grid.stallCoords has a point that is not finite.`);
    }
    if (!isNumber(stall.no_of_open_sides)) problems.push(`${at}.no_of_open_sides is not a number.`);
    if (!Array.isArray(stall.category_id) || !stall.category_id.every(isNumber)) {
      problems.push(`${at}.category_id must be a list of numbers.`);
    }
    for (const flag of [
      'is_premium',
      'is_blocked',
      'is_fnb_stall',
      'is_branding_stall',
      'is_horseshoe_stall',
      'is_marquee_available',
      'is_restricted_for_overseas',
    ]) {
      if (typeof stall[flag] !== 'boolean') problems.push(`${at}.${flag} is not true or false.`);
    }
  });
  return problems;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || path !== PATH) {
    return send(res, refusal(404, 'NOT_FOUND', 'No such route.'));
  }
  const secret = process.env.VENUE_STUB_SECRET;
  if (!secret) {
    return send(res, refusal(404, 'NOT_FOUND', 'The endpoint is off: VENUE_STUB_SECRET is not set.'));
  }
  const raw = await rawBody(req);
  if (!raw) {
    return send(res, refusal(413, 'BODY_TOO_LARGE', 'The body is over 5 MB.'));
  }

  const deliveryId = header(req, 'x-platform-delivery') ?? '';
  const timestamp = header(req, 'x-platform-timestamp') ?? '';
  const signature = header(req, 'x-platform-signature') ?? '';
  if (!signature || !timestamp || !signatureValid(secret, timestamp, raw, signature)) {
    log(deliveryId, null, null, '401 BAD_SIGNATURE');
    return send(res, refusal(401, 'BAD_SIGNATURE', 'The signature is missing or wrong.'));
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) {
    log(deliveryId, null, null, '401 STALE_TIMESTAMP');
    return send(res, refusal(401, 'STALE_TIMESTAMP', 'The timestamp is more than 300 s away.'));
  }

  const seen = answers.get(deliveryId);
  if (seen) {
    log(deliveryId, null, null, `${seen.status} (seen before, same answer)`);
    return send(res, seen);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    body = undefined;
  }
  const answer = decide(body, deliveryId);
  if (deliveryId) answers.set(deliveryId, answer);
  const plan = isObject(body) && isObject(body.plan) ? body.plan : null;
  log(
    deliveryId,
    plan && isNumber(plan.revision) ? plan.revision : null,
    plan && Array.isArray(plan.stalls) ? plan.stalls.length : null,
    `${answer.status} ${String(answer.body.code ?? answer.body.outcome)}`,
  );
  if (body !== undefined) console.log(JSON.stringify(body, null, 2));
  return send(res, answer);
}

function decide(body: unknown, deliveryId: string): Answer {
  const problems = bodyProblems(body, deliveryId);
  if (problems.length || !isObject(body)) {
    return refusal(400, 'INVALID_BODY', `The body has ${problems.length} problem(s).`, { problems });
  }
  const event = body.event as Json;
  const hall = body.hall as Json;
  const plan = body.plan as Json & { stalls: unknown[] };
  const key = `${String(event.itpoBookingId)}|${String(hall.itpoHallId)}`;
  const last = applied.get(key);
  const revision = plan.revision as number;
  if (last !== undefined && revision <= last) {
    return refusal(409, 'STALE_REVISION', `Revision ${last} is already applied.`, {
      appliedRevision: last,
    });
  }
  if (existsSync(BOOKINGS_FLAG) || process.env.VENUE_STUB_HAS_BOOKINGS === '1') {
    return refusal(409, 'EVENT_HALL_HAS_BOOKINGS', 'The event hall has bookings.', {
      stalls: ['H7B-06 A'],
    });
  }
  applied.set(key, revision);
  return {
    status: 200,
    body: {
      outcome: 'applied',
      deliveryId,
      revision,
      eventHallId: 'stub',
      stallsApplied: plan.stalls.length,
      stallsDeactivated: 0,
      // ./.venue-stub-no-layout (or VENUE_STUB_NO_LAYOUT=1) plays a hall with no base layout.
      ...(existsSync('./.venue-stub-no-layout') || process.env.VENUE_STUB_NO_LAYOUT === '1'
        ? { warnings: ['HALL_HAS_NO_BASE_LAYOUT'] }
        : {}),
    },
  };
}

function log(
  deliveryId: string,
  revision: number | null,
  stalls: number | null,
  outcome: string,
): void {
  console.log(
    `${new Date().toISOString()} delivery ${deliveryId || '-'} revision ${revision ?? '-'} ` +
      `stalls ${stalls ?? '-'} -> ${outcome}`,
  );
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) send(res, refusal(500, 'STUB_ERROR', 'The stub failed.'));
  });
}).listen(PORT, () => {
  console.log(`Venue system stub on http://localhost:${PORT}${PATH}`);
  if (!process.env.VENUE_STUB_SECRET) console.log('VENUE_STUB_SECRET is not set: every push gets 404.');
});
