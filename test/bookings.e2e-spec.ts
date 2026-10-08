import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { signVenueBody } from '../src/bookings/venue-signature';
import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

interface StallRow {
  id: string;
  number: string;
  state: string;
  booking: { id: string; exhibitor: string; own: boolean } | null;
}

/**
 * Stall bookings end to end: staff hold, confirm, move and cancel stalls for registered
 * exhibitors; exhibitors hold their own through the portal when the organisation allows it;
 * one active booking per stall; bookings stay inside their organisation and their exhibitor;
 * the SelfCare export; and the venue system's signed, idempotent status callback.
 */
describe('Bookings (e2e)', () => {
  const SLUG = 'book-itpo';
  const ORG = `/api/orgs/${SLUG}`;

  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let organisationId: string;
  let owner: string;
  let outsider: string;
  let exhibitorA: string;
  let exhibitorB: string;
  let eventId: string;
  let hallId: string;
  let draftHallId: string;
  let acme: string;
  let looms: string;
  let unregistered: string;
  let stall: Record<string, string>;
  let draftStallId: string;
  // Bookings made along the way, by what they are.
  let confirmedId: string;
  let loomsHoldId: string;
  let hybridId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function organisation(slug: string, email: string) {
    const res = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: `Org ${slug}`, slug, firstAdmin: { email } })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(res.body.invitation.inviteUrl)}/accept`)
      .send({ name: `Owner ${slug}`, password: 'owner-password-1' })
      .expect(200);
    return { id: res.body.organisation.id as string, token: accepted.body.accessToken as string };
  }

  /** The Super Admin's switches: the exhibitor portal and the booking mode. */
  async function platform(exhibitorPortal: boolean, bookingMode: string) {
    await http
      .patch(`/api/admin/organisations/${organisationId}`)
      .set(auth(root))
      .send({
        bookingMode,
        features: { aiAssist: false, pdfPlot: true, exhibitorPortal, wayfinding: false },
      })
      .expect(200);
  }

  async function exhibitorUser(exhibitorId: string, email: string, roleId: string) {
    const invited = await http
      .post(`${ORG}/invitations`)
      .set(auth(owner))
      .send({ email, roleId, eventIds: [eventId], exhibitorId })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: email, password: 'exhibitor-password-1' })
      .expect(200);
    return accepted.body.accessToken as string;
  }

  function book(stallId: string, exhibitorId: string, extra: Record<string, unknown> = {}) {
    return http
      .post(`${ORG}/bookings`)
      .set(auth(owner))
      .send({ eventId, stallId, exhibitorId, ...extra });
  }

  function hold(token: string, stallId: string) {
    return http.post(`${ORG}/portal/bookings`).set(auth(token)).send({ eventId, stallId });
  }

  /** A status report from the venue's system, signed as it would sign it. */
  function venueReport(
    body: Record<string, unknown>,
    options: { slug?: string; secret?: string; ts?: string } = {},
  ) {
    const raw = JSON.stringify(body);
    const ts = options.ts ?? String(Math.floor(Date.now() / 1000));
    const secret = options.secret ?? process.env.VENUE_SYSTEM_WEBHOOK_SECRET!;
    return http
      .post(`/api/integrations/venue-system/${options.slug ?? SLUG}/booking-status`)
      .set('content-type', 'application/json')
      .set('x-venue-timestamp', ts)
      .set('x-venue-signature', signVenueBody(secret, ts, raw))
      .send(raw);
  }

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const itpo = await organisation(SLUG, 'ops@book-itpo.test');
    organisationId = itpo.id;
    owner = itpo.token;
    outsider = (await organisation('book-jio', 'ops@book-jio.test')).token;

    // A venue with two 40 x 30 m halls, both booked by one event.
    const venue = await http
      .post(`${ORG}/venues`)
      .set(auth(owner))
      .send({ name: 'Booking venue' })
      .expect(201);
    const hall = (name: string) =>
      http
        .post(`${ORG}/venues/${venue.body.id}/halls`)
        .set(auth(owner))
        .send({ name, width: 40, depth: 30 })
        .expect(201);
    hallId = (await hall('Hall 1')).body.id;
    draftHallId = (await hall('Hall 2')).body.id;
    eventId = (
      await http
        .post(`${ORG}/events`)
        .set(auth(owner))
        .send({
          venueId: venue.body.id,
          name: 'Trade Fair',
          kind: 'internal',
          eventType: 'B2B',
          startsOn: '2026-11-14',
          endsOn: '2026-11-27',
        })
        .expect(201)
    ).body.id;
    for (const id of [hallId, draftHallId]) {
      await http.put(`${ORG}/events/${eventId}/halls/${id}`).set(auth(owner)).expect(200);
    }

    // Two exhibitors take part; a third does not.
    const exhibitor = async (name: string) =>
      (await http.post(`${ORG}/exhibitors`).set(auth(owner)).send({ name }).expect(201)).body
        .id as string;
    acme = await exhibitor('Acme Exports');
    looms = await exhibitor('Bharat Looms');
    unregistered = await exhibitor('Elsewhere Traders');
    for (const id of [acme, looms]) {
      await http.put(`${ORG}/events/${eventId}/exhibitors/${id}`).set(auth(owner)).expect(200);
    }

    // Six 3 x 3 m stalls in a row, 4 m apart, published; one more stall in a draft plan.
    const saved = await http
      .put(`${ORG}/events/${eventId}/halls/${hallId}/plan`)
      .set(auth(owner))
      .send({
        revision: 0,
        stalls: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((number, i) => ({
          number,
          x: 5 + i * 5,
          y: 5,
          width: 3,
          depth: 3,
          openSides: ['bottom'],
          stallType: number === 'S6' ? 'shell' : null,
        })),
      })
      .expect(200);
    stall = Object.fromEntries(
      saved.body.stalls.map((s: { id: string; number: string }) => [s.number, s.id]),
    );
    expect(saved.body.report.passed).toBe(true);
    const approved = await http
      .post(`${ORG}/events/${eventId}/halls/${hallId}/plan/approve`)
      .set(auth(owner))
      .send({ revision: saved.body.revision })
      .expect(200);
    await http
      .post(`${ORG}/events/${eventId}/halls/${hallId}/plan/publish`)
      .set(auth(owner))
      .send({ revision: approved.body.revision })
      .expect(200);
    const draft = await http
      .put(`${ORG}/events/${eventId}/halls/${draftHallId}/plan`)
      .set(auth(owner))
      .send({
        revision: 0,
        stalls: [{ number: 'D1', x: 5, y: 5, width: 3, depth: 3, openSides: ['bottom'] }],
      })
      .expect(200);
    draftStallId = draft.body.stalls[0].id;

    // Each exhibitor's own user, with the event-scoped exhibitor role.
    const roles = await http.get(`${ORG}/roles`).set(auth(owner)).expect(200);
    const exhibitorRole = roles.body.find((r: { key: string }) => r.key === 'exhibitor').id;
    exhibitorA = await exhibitorUser(acme, 'sales@acme.test', exhibitorRole);
    exhibitorB = await exhibitorUser(looms, 'sales@looms.test', exhibitorRole);
  });

  afterAll(async () => {
    await app.close();
  });

  it('books nothing until the event is scheduled', async () => {
    const res = await book(stall.S1, acme).expect(409);
    expect(res.body.message).toMatch(/scheduled/);
    await http
      .post(`${ORG}/events/${eventId}/status`)
      .set(auth(owner))
      .send({ status: 'scheduled' })
      .expect(200);
  });

  it('holds a stall for a registered exhibitor, then confirms it', async () => {
    const held = await book(stall.S1, acme, { note: 'Corner please' }).expect(201);
    expect(held.body).toMatchObject({
      event: { id: eventId, name: 'Trade Fair', status: 'scheduled' },
      hall: { id: hallId, name: 'Hall 1' },
      stall: { id: stall.S1, number: 'S1', area: 9, openSides: ['bottom'], stallType: null },
      exhibitor: { id: acme, name: 'Acme Exports' },
      channel: 'internal',
      status: 'held',
      paymentStatus: null,
      note: 'Corner please',
      confirmedAt: null,
    });
    confirmedId = held.body.id;

    const confirmed = await http
      .post(`${ORG}/bookings/${confirmedId}/confirm`)
      .set(auth(owner))
      .expect(200);
    expect(confirmed.body).toMatchObject({ status: 'confirmed', paymentStatus: null });
    expect(confirmed.body.confirmedAt).toEqual(expect.any(String));
    await http.post(`${ORG}/bookings/${confirmedId}/confirm`).set(auth(owner)).expect(409);

    const one = await http.get(`${ORG}/bookings/${confirmedId}`).set(auth(owner)).expect(200);
    expect(one.body.status).toBe('confirmed');
    const listed = await http
      .get(`${ORG}/bookings?eventId=${eventId}&status=confirmed`)
      .set(auth(owner))
      .expect(200);
    expect(listed.body.map((b: { id: string }) => b.id)).toEqual([confirmedId]);
  });

  it('allows one active booking per stall', async () => {
    const res = await book(stall.S1, looms).expect(409);
    expect(res.body.message).toMatch(/S1 is already booked/);
  });

  it('books only published stalls, and only for registered exhibitors', async () => {
    const draft = await book(draftStallId, acme).expect(409);
    expect(draft.body.message).toMatch(/not open for booking/);
    const notRegistered = await book(stall.S2, unregistered).expect(409);
    expect(notRegistered.body.message).toMatch(/Register Elsewhere Traders/);
  });

  it('keeps the exhibitor portal closed until it is switched on, and in sync mode', async () => {
    const off = await hold(exhibitorA, stall.S2).expect(403);
    expect(off.body.message).toMatch(/not switched on/);
    const portal = await http.get(`${ORG}/portal`).set(auth(exhibitorA)).expect(200);
    expect(portal.body.closedReason).toMatch(/not switched on/);

    await platform(true, 'sync');
    const sync = await hold(exhibitorA, stall.S2).expect(403);
    expect(sync.body.message).toMatch(/own booking system/);
    await platform(true, 'own_portal');
  });

  it("lets an exhibitor's user hold a free stall for its own company", async () => {
    const res = await hold(exhibitorA, stall.S2).expect(201);
    expect(res.body).toMatchObject({
      stall: { number: 'S2' },
      exhibitor: { id: acme },
      channel: 'external',
      status: 'held',
      paymentStatus: null,
    });

    const portal = await http.get(`${ORG}/portal`).set(auth(exhibitorA)).expect(200);
    expect(portal.body).toMatchObject({
      exhibitor: { id: acme, name: 'Acme Exports' },
      bookingMode: 'own_portal',
      closedReason: null,
      events: [{ id: eventId, name: 'Trade Fair', status: 'scheduled', venue: 'Booking venue' }],
    });
    expect(portal.body.events[0].halls).toEqual([
      { hallId, name: 'Hall 1', published: true, freeStalls: 4 },
      { hallId: draftHallId, name: 'Hall 2', published: false, freeStalls: 0 },
    ]);
  });

  it("shows an exhibitor its own bookings, and others' stalls without their name", async () => {
    loomsHoldId = (await hold(exhibitorB, stall.S3).expect(201)).body.id;

    const mine = await http.get(`${ORG}/portal/bookings`).set(auth(exhibitorA)).expect(200);
    expect(mine.body.map((b: { stall: { number: string } }) => b.stall.number).sort()).toEqual([
      'S1',
      'S2',
    ]);
    expect(mine.body.every((b: { exhibitor: { id: string } }) => b.exhibitor.id === acme)).toBe(
      true,
    );

    const map = await http
      .get(`${ORG}/portal/events/${eventId}/halls/${hallId}/stalls`)
      .set(auth(exhibitorA))
      .expect(200);
    expect(map.body).toMatchObject({ bookable: true, hall: { id: hallId, floorVersion: 1 } });
    const byNumber = (rows: StallRow[]) => Object.fromEntries(rows.map((s) => [s.number, s]));
    const seen = byNumber(map.body.stalls);
    expect(seen.S1).toMatchObject({ state: 'booked', booking: { own: true } });
    expect(seen.S2).toMatchObject({
      state: 'held',
      booking: { exhibitor: 'Acme Exports', own: true },
    });
    expect(seen.S3).toMatchObject({ state: 'held', booking: null });
    expect(seen.S4).toMatchObject({ state: 'free', booking: null });

    const staff = await http
      .get(`${ORG}/events/${eventId}/halls/${hallId}/stalls`)
      .set(auth(owner))
      .expect(200);
    expect(byNumber(staff.body.stalls).S3).toMatchObject({
      state: 'held',
      booking: { id: loomsHoldId, exhibitor: 'Bharat Looms', own: false },
    });

    // Another exhibitor's booking does not exist for this one.
    await http
      .post(`${ORG}/portal/bookings/${loomsHoldId}/cancel`)
      .set(auth(exhibitorA))
      .send({})
      .expect(404);
  });

  it('lets an exhibitor let go of its own hold, never of a confirmed booking', async () => {
    const confirmed = await http
      .post(`${ORG}/portal/bookings/${confirmedId}/cancel`)
      .set(auth(exhibitorA))
      .send({})
      .expect(409);
    expect(confirmed.body.message).toMatch(/organiser/);

    const mine = await http.get(`${ORG}/portal/bookings`).set(auth(exhibitorA)).expect(200);
    const s2 = mine.body.find((b: { stall: { number: string } }) => b.stall.number === 'S2');
    const cancelled = await http
      .post(`${ORG}/portal/bookings/${s2.id}/cancel`)
      .set(auth(exhibitorA))
      .send({ reason: 'Changed plans' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Changed plans' });
  });

  it('keeps exhibitors off the staff routes', async () => {
    await http.get(`${ORG}/bookings`).set(auth(exhibitorA)).expect(403);
    await http.get(`${ORG}/bookings/${confirmedId}`).set(auth(exhibitorA)).expect(403);
    await http
      .post(`${ORG}/bookings`)
      .set(auth(exhibitorA))
      .send({ eventId, stallId: stall.S4, exhibitorId: acme })
      .expect(403);
    await http
      .get(`${ORG}/events/${eventId}/halls/${hallId}/stalls`)
      .set(auth(exhibitorA))
      .expect(403);
    // And staff without an exhibitor of their own off the portal's bookings.
    await hold(owner, stall.S4).expect(403);
  });

  it('moves a booking to a free stall, never onto a taken one', async () => {
    const taken = await http
      .post(`${ORG}/bookings/${confirmedId}/move`)
      .set(auth(owner))
      .send({ stallId: stall.S3 })
      .expect(409);
    expect(taken.body.message).toMatch(/S3 is already held/);
    const moved = await http
      .post(`${ORG}/bookings/${confirmedId}/move`)
      .set(auth(owner))
      .send({ stallId: stall.S4 })
      .expect(200);
    expect(moved.body).toMatchObject({ status: 'confirmed', stall: { number: 'S4' } });
    await http
      .post(`${ORG}/bookings/${confirmedId}/move`)
      .set(auth(owner))
      .send({ stallId: stall.S4 })
      .expect(409);
    // S1 is free again.
    const map = await http
      .get(`${ORG}/events/${eventId}/halls/${hallId}/stalls`)
      .set(auth(owner))
      .expect(200);
    expect(map.body.stalls.find((s: StallRow) => s.number === 'S1').state).toBe('free');
  });

  it('frees the stall when a booking is cancelled, so it can be booked again', async () => {
    await http.post(`${ORG}/bookings/${loomsHoldId}/cancel`).set(auth(owner)).send({}).expect(400);
    const cancelled = await http
      .post(`${ORG}/bookings/${loomsHoldId}/cancel`)
      .set(auth(owner))
      .send({ reason: 'Asked to move halls' })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Asked to move halls',
    });
    await http
      .post(`${ORG}/bookings/${loomsHoldId}/cancel`)
      .set(auth(owner))
      .send({ reason: 'Again' })
      .expect(409);
    const rebooked = await book(stall.S3, acme).expect(201);
    expect(rebooked.body).toMatchObject({ status: 'held', stall: { number: 'S3' } });
  });

  it('keeps the plan and the event while stalls are held or booked', async () => {
    const plan = await http
      .get(`${ORG}/events/${eventId}/halls/${hallId}/plan`)
      .set(auth(owner))
      .expect(200);
    const reopen = await http
      .post(`${ORG}/events/${eventId}/halls/${hallId}/plan/reopen`)
      .set(auth(owner))
      .send({ revision: plan.body.revision })
      .expect(409);
    expect(reopen.body.message).toMatch(/held or booked/);
    for (const status of ['cancelled', 'draft']) {
      const res = await http
        .post(`${ORG}/events/${eventId}/status`)
        .set(auth(owner))
        .send({ status })
        .expect(409);
      expect(res.body.message).toMatch(/active booking/);
    }
  });

  it('keeps bookings inside their organisation', async () => {
    await http.get(`${ORG}/bookings`).set(auth(outsider)).expect(403);
    await http.get(`${ORG}/bookings/${confirmedId}`).set(auth(outsider)).expect(403);
    await http.get(`/api/orgs/book-jio/bookings/${confirmedId}`).set(auth(outsider)).expect(404);
    await http
      .post(`/api/orgs/book-jio/bookings/${confirmedId}/cancel`)
      .set(auth(outsider))
      .send({ reason: 'Not mine' })
      .expect(404);
    const theirs = await http.get('/api/orgs/book-jio/bookings').set(auth(outsider)).expect(200);
    expect(theirs.body).toEqual([]);
  });

  it('tracks payment only for holds in hybrid_hold mode', async () => {
    const ownPortal = await book(stall.S5, looms).expect(201);
    expect(ownPortal.body.paymentStatus).toBeNull();
    await http
      .post(`${ORG}/bookings/${ownPortal.body.id}/cancel`)
      .set(auth(owner))
      .send({ reason: 'Test hold' })
      .expect(200);

    await platform(true, 'hybrid_hold');
    const res = await hold(exhibitorA, stall.S6).expect(201);
    expect(res.body).toMatchObject({ status: 'held', paymentStatus: 'pending' });
    hybridId = res.body.id;
    // Confirmed at once by staff: nothing for the venue's system to collect.
    const confirmed = await book(stall.S5, looms, { confirm: true }).expect(201);
    expect(confirmed.body).toMatchObject({ status: 'confirmed', paymentStatus: null });
  });

  it('exports a held booking as SelfCare rows, and only a held one', async () => {
    const res = await http
      .post(`${ORG}/bookings/${hybridId}/selfcare-row`)
      .set(auth(owner))
      .send({ hall_id: 67, pricing: { shell_rate: 17600, corner_charges_applicable: true } })
      .expect(200);
    expect(res.body.T_STALLS).toMatchObject({
      id: null,
      hall_id: 67,
      island_number: 'S6',
      stall_number: null,
      booking_status: 'In-Progress',
      no_of_open_sides: 1,
    });
    expect(res.body.T_STALL_BOOKING).toMatchObject({
      event_name: 'Trade Fair',
      booking_status: 'Pending',
      payment_status: 'Pending',
    });
    expect(res.body.T_STALL_BOOKING_DETAIL).toEqual([
      expect.objectContaining({
        stall_type: 'shell',
        area: 9,
        rate: 17600,
        rental: 158400,
        corner_charge: 0,
        total: 158400,
        net_payable_amount: 158400,
      }),
    ]);
    // A shell stall priced without a shell rate: no amount, rather than a guess or an error.
    const unpriced = await http
      .post(`${ORG}/bookings/${hybridId}/selfcare-row`)
      .set(auth(owner))
      .send({ pricing: { bare_rate: 16000, corner_charges_applicable: true } })
      .expect(200);
    expect(unpriced.body.T_STALL_BOOKING_DETAIL[0]).toMatchObject({
      rate: null,
      total: null,
      net_payable_amount: null,
    });
    const confirmed = await http
      .post(`${ORG}/bookings/${confirmedId}/selfcare-row`)
      .set(auth(owner))
      .send({})
      .expect(409);
    expect(confirmed.body.message).toMatch(/Only a held booking/);
  });

  describe('venue system status callback', () => {
    const paid = () => ({
      deliveryId: 'sc-1',
      bookingId: hybridId,
      bookingStatus: 'Confirmed',
      paymentStatus: 'Completed',
      externalRef: 'SC-2026-0001',
    });

    it('refuses unsigned, wrongly signed and stale reports', async () => {
      const raw = JSON.stringify(paid());
      const unsigned = await http
        .post(`/api/integrations/venue-system/${SLUG}/booking-status`)
        .set('content-type', 'application/json')
        .send(raw)
        .expect(401);
      expect(unsigned.body.message).toMatch(/not signed/);
      const wrong = await venueReport(paid(), {
        secret: 'not-the-secret-not-the-secret-not-the-secret',
      }).expect(401);
      expect(wrong.body.message).toMatch(/does not match/);
      const stale = await venueReport(paid(), {
        ts: String(Math.floor(Date.now() / 1000) - 600),
      }).expect(401);
      expect(stale.body.message).toMatch(/too old/);
      // Nothing moved.
      const booking = await http.get(`${ORG}/bookings/${hybridId}`).set(auth(owner)).expect(200);
      expect(booking.body).toMatchObject({ status: 'held', paymentStatus: 'pending' });
    });

    it('validates a genuine report like any other request', async () => {
      await venueReport({ ...paid(), bookingStatus: 'Booked' }).expect(400);
    });

    it('confirms a held booking once its payment is completed', async () => {
      const res = await venueReport(paid()).expect(200);
      expect(res.body).toEqual({ outcome: 'confirmed' });
      const booking = await http.get(`${ORG}/bookings/${hybridId}`).set(auth(owner)).expect(200);
      expect(booking.body).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'completed',
        externalRef: 'SC-2026-0001',
      });
    });

    it('does nothing for a delivery it already received', async () => {
      const res = await venueReport({
        ...paid(),
        bookingStatus: 'Cancelled',
        paymentStatus: 'Cancelled',
      }).expect(200);
      expect(res.body).toEqual({ outcome: 'duplicate' });
      const booking = await http.get(`${ORG}/bookings/${hybridId}`).set(auth(owner)).expect(200);
      expect(booking.body).toMatchObject({ status: 'confirmed', paymentStatus: 'completed' });
    });

    it('leaves a confirmed booking to staff on a timeout', async () => {
      const before = await http.get(`${ORG}/bookings/${hybridId}`).set(auth(owner)).expect(200);
      const res = await venueReport({
        deliveryId: 'sc-2',
        bookingId: hybridId,
        bookingStatus: 'Timeout',
        paymentStatus: 'Timeout',
        externalRef: 'SC-2026-0001',
      }).expect(200);
      expect(res.body).toEqual({ outcome: 'ignored:confirmed' });
      const after = await http.get(`${ORG}/bookings/${hybridId}`).set(auth(owner)).expect(200);
      expect(after.body).toEqual(before.body);
    });

    it('answers for unknown bookings and other organisations without changing them', async () => {
      const unknown = await venueReport({ ...paid(), deliveryId: 'sc-3', bookingId: randomUUID() });
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ outcome: 'ignored:unknown_booking' });
      const elsewhere = await venueReport(
        { ...paid(), deliveryId: 'sc-4', bookingId: confirmedId },
        { slug: 'book-jio' },
      ).expect(200);
      expect(elsewhere.body).toEqual({ outcome: 'ignored:unknown_booking' });
      await venueReport({ ...paid(), deliveryId: 'sc-5' }, { slug: 'no-such-org' }).expect(404);
    });

    it('ends a held booking on a timeout, and never revives a cancelled one', async () => {
      const expiring = (await hold(exhibitorB, stall.S2).expect(201)).body.id;
      const expired = await venueReport({
        deliveryId: 'sc-6',
        bookingId: expiring,
        bookingStatus: 'Timeout',
        paymentStatus: 'Timeout',
      }).expect(200);
      expect(expired.body).toEqual({ outcome: 'expired' });
      const gone = await http.get(`${ORG}/bookings/${expiring}`).set(auth(owner)).expect(200);
      expect(gone.body).toMatchObject({ status: 'expired', paymentStatus: 'timeout' });

      const dropped = (await hold(exhibitorB, stall.S2).expect(201)).body.id;
      await http
        .post(`${ORG}/portal/bookings/${dropped}/cancel`)
        .set(auth(exhibitorB))
        .send({})
        .expect(200);
      const late = await venueReport({
        deliveryId: 'sc-7',
        bookingId: dropped,
        bookingStatus: 'Confirmed',
        paymentStatus: 'Completed',
      }).expect(200);
      expect(late.body).toEqual({ outcome: 'ignored:cancelled' });
      const still = await http.get(`${ORG}/bookings/${dropped}`).set(auth(owner)).expect(200);
      expect(still.body).toMatchObject({ status: 'cancelled', paymentStatus: 'pending' });
    });

    it('refuses a reference that already belongs to another booking', async () => {
      const other = (await hold(exhibitorB, stall.S2).expect(201)).body.id;
      const res = await venueReport({
        deliveryId: 'sc-8',
        bookingId: other,
        bookingStatus: 'Pending',
        paymentStatus: 'Pending',
        externalRef: 'SC-2026-0001',
      }).expect(409);
      expect(res.body.message).toMatch(/another booking/);
      const booking = await http.get(`${ORG}/bookings/${other}`).set(auth(owner)).expect(200);
      expect(booking.body.externalRef).toBeNull();
    });
  });
});
