import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

const UNKNOWN_ID = '7d3f9a52-1b8e-4c2a-9f0e-2a1b3c4d5e6f';

interface EventRow {
  id: string;
  name: string;
}

/**
 * Module D end to end: events at an organisation's venues, the halls they book without two
 * events holding a hall on the same day, their life cycle, and event-scoped members who see
 * only their own events.
 */
describe('Events (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let outsider: string;
  let organisationId: string;
  let venueId: string;
  let annexId: string;
  let outsiderVenueId: string;
  let hall1: string;
  let hall2: string;
  let annexHall: string;
  let fair: string;
  let expo: string;
  let bookFair: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function organisation(slug: string, email: string, limits?: object) {
    const res = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: `Org ${slug}`, slug, firstAdmin: { email }, ...(limits ? { limits } : {}) })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(res.body.invitation.inviteUrl)}/accept`)
      .send({ name: `Owner ${slug}`, password: 'owner-password-1' })
      .expect(200);
    return { id: res.body.organisation.id as string, token: accepted.body.accessToken as string };
  }

  /** Invites a person with the role (and events) and returns their token once they accept. */
  async function member(email: string, roleId: string, eventIds?: string[]) {
    const invited = await http
      .post('/api/orgs/events-itpo/invitations')
      .set(auth(owner))
      .send({ email, roleId, ...(eventIds ? { eventIds } : {}) })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: email, password: 'member-password-1' })
      .expect(200);
    return accepted.body.accessToken as string;
  }

  async function hall(venue: string, name: string) {
    return (
      await http
        .post(`/api/orgs/events-itpo/venues/${venue}/halls`)
        .set(auth(owner))
        .send({ name, width: 40, depth: 30 })
        .expect(201)
    ).body.id as string;
  }

  const event = (body: object) =>
    http
      .post('/api/orgs/events-itpo/events')
      .set(auth(owner))
      .send({ venueId, kind: 'internal', eventType: 'B2B', ...body });

  const setStatus = (eventId: string, body: object, token = owner) =>
    http.post(`/api/orgs/events-itpo/events/${eventId}/status`).set(auth(token)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;

    const itpo = await organisation('events-itpo', 'ops@events-itpo.test', {
      venues: 2,
      users: 25,
      storageMb: 1024,
    });
    organisationId = itpo.id;
    owner = itpo.token;
    outsider = (await organisation('events-jio', 'ops@events-jio.test')).token;

    venueId = (
      await http
        .post('/api/orgs/events-itpo/venues')
        .set(auth(owner))
        .send({ name: 'Bharat Mandapam' })
        .expect(201)
    ).body.id;
    annexId = (
      await http
        .post('/api/orgs/events-itpo/venues')
        .set(auth(owner))
        .send({ name: 'Annex' })
        .expect(201)
    ).body.id;
    outsiderVenueId = (
      await http
        .post('/api/orgs/events-jio/venues')
        .set(auth(outsider))
        .send({ name: 'Jio World Centre' })
        .expect(201)
    ).body.id;
    hall1 = await hall(venueId, 'Hall 1');
    hall2 = await hall(venueId, 'Hall 2');
    annexHall = await hall(annexId, 'Annex Hall');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('events', () => {
    it('creates an event as a draft at one of its venues', async () => {
      const res = await event({
        name: 'India International Trade Fair',
        code: 'IITF',
        startsOn: '2027-02-10',
        endsOn: '2027-02-14',
        organiserEmail: 'Events@ITPO.test',
      }).expect(201);
      fair = res.body.id;
      expect(res.body).toMatchObject({
        name: 'India International Trade Fair',
        code: 'IITF',
        kind: 'internal',
        eventType: 'B2B',
        status: 'draft',
        startsOn: '2027-02-10',
        endsOn: '2027-02-14',
        venue: { id: venueId, name: 'Bharat Mandapam' },
        organiser: { name: null, email: 'events@itpo.test', phone: null },
        cancelledReason: null,
        hallCount: 0,
      });
    });

    it('refuses wrong days, an unknown venue and a code already used', async () => {
      const before = await event({
        name: 'Backwards',
        startsOn: '2027-02-14',
        endsOn: '2027-02-10',
      }).expect(400);
      expect(before.body.message).toBe('The last day cannot be before the first day.');
      const unreal = await event({
        name: 'Unreal',
        startsOn: '2027-02-27',
        endsOn: '2027-02-30',
      }).expect(400);
      expect(unreal.body.message).toBe('Use real calendar days for the event dates.');
      await event({ name: 'Format', startsOn: '10-02-2027', endsOn: '2027-02-12' }).expect(400);

      await event({
        name: 'Nowhere',
        venueId: UNKNOWN_ID,
        startsOn: '2027-02-10',
        endsOn: '2027-02-12',
      }).expect(404);
      await event({
        name: 'Elsewhere',
        venueId: outsiderVenueId,
        startsOn: '2027-02-10',
        endsOn: '2027-02-12',
      }).expect(404);

      const used = await event({
        name: 'Copy',
        code: 'iitf',
        startsOn: '2027-05-01',
        endsOn: '2027-05-02',
      }).expect(409);
      expect(used.body.message).toMatch(/already used by India International Trade Fair/);
    });

    it('lists events latest first, filtered by status and venue', async () => {
      expo = (
        await event({
          name: 'Auto Expo',
          code: 'AUTO',
          kind: 'external',
          eventType: 'B2C',
          startsOn: '2027-02-12',
          endsOn: '2027-02-16',
        }).expect(201)
      ).body.id;
      bookFair = (
        await event({
          name: 'World Book Fair',
          startsOn: '2027-03-01',
          endsOn: '2027-03-03',
        }).expect(201)
      ).body.id;

      const all = await http.get('/api/orgs/events-itpo/events').set(auth(owner)).expect(200);
      expect((all.body as EventRow[]).map((e) => e.name)).toEqual([
        'World Book Fair',
        'Auto Expo',
        'India International Trade Fair',
      ]);
      const drafts = await http
        .get('/api/orgs/events-itpo/events?status=draft')
        .set(auth(owner))
        .expect(200);
      expect(drafts.body).toHaveLength(3);
      const scheduled = await http
        .get('/api/orgs/events-itpo/events?status=scheduled')
        .set(auth(owner))
        .expect(200);
      expect(scheduled.body).toEqual([]);
      const annex = await http
        .get(`/api/orgs/events-itpo/events?venueId=${annexId}`)
        .set(auth(owner))
        .expect(200);
      expect(annex.body).toEqual([]);
      await http.get('/api/orgs/events-itpo/events?status=archived').set(auth(owner)).expect(400);
    });

    it('shows an event with its halls and updates its details', async () => {
      const detail = await http
        .get(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(owner))
        .expect(200);
      expect(detail.body).toMatchObject({ id: fair, halls: [] });

      const updated = await http
        .patch(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(owner))
        .send({ organiserName: 'ITPO Events', description: 'The flagship fair', code: 'iitf' })
        .expect(200);
      expect(updated.body).toMatchObject({
        code: 'iitf',
        organiser: { name: 'ITPO Events', email: 'events@itpo.test' },
        description: 'The flagship fair',
      });

      await http
        .patch(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(owner))
        .send({ code: 'Auto' })
        .expect(409);
      await http.get(`/api/orgs/events-itpo/events/${UNKNOWN_ID}`).set(auth(owner)).expect(404);
    });
  });

  describe('halls', () => {
    it('books a hall of the event’s venue, on its current floor', async () => {
      const res = await http
        .put(`/api/orgs/events-itpo/events/${fair}/halls/${hall1}`)
        .set(auth(owner))
        .expect(200);
      expect(res.body.hallCount).toBe(1);
      expect(res.body.halls).toEqual([
        expect.objectContaining({
          hallId: hall1,
          name: 'Hall 1',
          floorVersion: 1,
          currentVersion: 1,
        }),
      ]);

      // Booking it again changes nothing.
      const again = await http
        .put(`/api/orgs/events-itpo/events/${fair}/halls/${hall1}`)
        .set(auth(owner))
        .expect(200);
      expect(again.body.halls).toHaveLength(1);

      const other = await http
        .put(`/api/orgs/events-itpo/events/${fair}/halls/${annexHall}`)
        .set(auth(owner))
        .expect(400);
      expect(other.body.message).toBe('Annex Hall is in another venue.');
      await http
        .put(`/api/orgs/events-itpo/events/${fair}/halls/${UNKNOWN_ID}`)
        .set(auth(owner))
        .expect(404);
    });

    it('refuses a hall another event holds on overlapping days, drafts included', async () => {
      const res = await http
        .put(`/api/orgs/events-itpo/events/${expo}/halls/${hall1}`)
        .set(auth(owner))
        .expect(409);
      expect(res.body.message).toBe(
        'Hall 1 is already booked on these days by India International Trade Fair ' +
          '(2027-02-10 to 2027-02-14).',
      );

      await http
        .put(`/api/orgs/events-itpo/events/${bookFair}/halls/${hall1}`)
        .set(auth(owner))
        .expect(200);
    });

    it('shows the venue’s halls with the events that hold them', async () => {
      const res = await http
        .get(`/api/orgs/events-itpo/events/${expo}/hall-options`)
        .set(auth(owner))
        .expect(200);
      expect(res.body).toEqual([
        {
          hallId: hall1,
          name: 'Hall 1',
          code: null,
          booked: false,
          conflicts: [
            {
              eventId: fair,
              name: 'India International Trade Fair',
              startsOn: '2027-02-10',
              endsOn: '2027-02-14',
            },
          ],
        },
        { hallId: hall2, name: 'Hall 2', code: null, booked: false, conflicts: [] },
      ]);
    });

    it('checks the halls again when the dates change', async () => {
      const url = `/api/orgs/events-itpo/events/${bookFair}`;
      const clash = await http
        .patch(url)
        .set(auth(owner))
        .send({ startsOn: '2027-02-14' })
        .expect(409);
      expect(clash.body.message).toMatch(/^Hall 1 is already booked on these days by India/);

      const moved = await http
        .patch(url)
        .set(auth(owner))
        .send({ startsOn: '2027-02-15', endsOn: '2027-03-03' })
        .expect(200);
      expect(moved.body).toMatchObject({ startsOn: '2027-02-15', endsOn: '2027-03-03' });

      await http.patch(url).set(auth(owner)).send({ endsOn: '2027-02-01' }).expect(400);
      const venue = await http.patch(url).set(auth(owner)).send({ venueId: annexId }).expect(409);
      expect(venue.body.message).toMatch(/Remove its halls first/);
    });

    it('frees the halls of a cancelled event', async () => {
      const tentative = (
        await event({
          name: 'Tentative Show',
          startsOn: '2027-04-01',
          endsOn: '2027-04-03',
        }).expect(201)
      ).body.id;
      const spring = (
        await event({ name: 'Spring Fair', startsOn: '2027-04-02', endsOn: '2027-04-05' }).expect(
          201,
        )
      ).body.id;
      await http
        .put(`/api/orgs/events-itpo/events/${tentative}/halls/${hall2}`)
        .set(auth(owner))
        .expect(200);
      await http
        .put(`/api/orgs/events-itpo/events/${spring}/halls/${hall2}`)
        .set(auth(owner))
        .expect(409);

      const cancelled = await setStatus(tentative, {
        status: 'cancelled',
        reason: 'Dates not confirmed',
      }).expect(200);
      expect(cancelled.body).toMatchObject({
        status: 'cancelled',
        cancelledReason: 'Dates not confirmed',
      });
      await http
        .put(`/api/orgs/events-itpo/events/${spring}/halls/${hall2}`)
        .set(auth(owner))
        .expect(200);

      // A cancelled event no longer changes.
      const closed = await http
        .patch(`/api/orgs/events-itpo/events/${tentative}`)
        .set(auth(owner))
        .send({ name: 'Back again' })
        .expect(409);
      expect(closed.body.message).toBe('A cancelled event cannot change.');
    });

    it('removes a hall the event no longer books', async () => {
      const spring = (
        (await http.get('/api/orgs/events-itpo/events').set(auth(owner))).body as EventRow[]
      ).find((e) => e.name === 'Spring Fair')!.id;
      const url = `/api/orgs/events-itpo/events/${spring}/halls/${hall2}`;
      await http.delete(url).set(auth(owner)).expect(204);
      await http.delete(url).set(auth(owner)).expect(404);
      const detail = await http
        .get(`/api/orgs/events-itpo/events/${spring}`)
        .set(auth(owner))
        .expect(200);
      expect(detail.body).toMatchObject({ hallCount: 0, halls: [] });
    });

    it('keeps a hall or venue an event books from being deleted', async () => {
      await http.delete(`/api/orgs/events-itpo/halls/${hall1}`).set(auth(owner)).expect(409);
      await http.delete(`/api/orgs/events-itpo/venues/${venueId}`).set(auth(owner)).expect(409);
      await http.get(`/api/orgs/events-itpo/halls/${hall1}`).set(auth(owner)).expect(200);
    });
  });

  describe('life cycle', () => {
    it('moves only along the life cycle', async () => {
      const skip = await setStatus(fair, { status: 'completed' }).expect(409);
      expect(skip.body.message).toBe('An event cannot go from draft to completed.');
      await setStatus(fair, { status: 'draft' }).expect(400);
      await setStatus(fair, { status: 'archived' }).expect(400);

      const scheduled = await setStatus(fair, { status: 'scheduled' }).expect(200);
      expect(scheduled.body.status).toBe('scheduled');
      const early = await setStatus(fair, { status: 'completed' }).expect(409);
      expect(early.body.message).toBe('An event can be completed after its last day (2027-02-14).');

      await setStatus(fair, { status: 'draft' }).expect(200);
      await setStatus(fair, { status: 'scheduled' }).expect(200);
    });

    it('completes an event after its last day, and keeps it final', async () => {
      const past = (
        await event({ name: 'Winter Expo', startsOn: '2026-01-10', endsOn: '2026-01-12' }).expect(
          201,
        )
      ).body.id;
      await setStatus(past, { status: 'scheduled' }).expect(200);
      const completed = await setStatus(past, { status: 'completed' }).expect(200);
      expect(completed.body.status).toBe('completed');

      await setStatus(past, { status: 'draft' }).expect(409);
      await http
        .patch(`/api/orgs/events-itpo/events/${past}`)
        .set(auth(owner))
        .send({ name: 'Renamed' })
        .expect(409);
    });

    it('cancels with a reason, for good', async () => {
      const res = await setStatus(expo, {
        status: 'cancelled',
        reason: 'Organiser withdrew',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'cancelled',
        cancelledReason: 'Organiser withdrew',
      });
      const back = await setStatus(expo, { status: 'draft' }).expect(409);
      expect(back.body.message).toBe('An event cannot go from cancelled to draft.');
    });

    it('deletes only a draft', async () => {
      const refused = await http
        .delete(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(owner))
        .expect(409);
      expect(refused.body.message).toBe('Only a draft event can be deleted. Cancel it instead.');

      const draft = (
        await event({ name: 'Short Lived', startsOn: '2027-06-01', endsOn: '2027-06-01' }).expect(
          201,
        )
      ).body.id;
      await http
        .put(`/api/orgs/events-itpo/events/${draft}/halls/${hall2}`)
        .set(auth(owner))
        .expect(200);
      await http.delete(`/api/orgs/events-itpo/events/${draft}`).set(auth(owner)).expect(204);
      await http.get(`/api/orgs/events-itpo/events/${draft}`).set(auth(owner)).expect(404);
    });
  });

  describe('event scope', () => {
    let organiser: string;
    let manager: string;

    beforeAll(async () => {
      const roles = await http.get('/api/orgs/events-itpo/roles').set(auth(owner)).expect(200);
      const organiserAdmin = (roles.body as Array<{ id: string; key: string }>).find(
        (role) => role.key === 'organiser_admin',
      )!;
      organiser = await member('organiser@events-itpo.test', organiserAdmin.id, [fair]);

      // An event role that may manage events, to reach the whole-organisation checks.
      const role = await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({
          organisationId,
          key: 'event_manager',
          name: 'Event manager',
          scopeKind: 'event',
          permissions: ['events.view', 'events.manage'],
        })
        .expect(201);
      manager = await member('manager@events-itpo.test', role.body.id, [fair]);
    });

    it('shows an event-scoped member only its own events', async () => {
      const list = await http.get('/api/orgs/events-itpo/events').set(auth(organiser)).expect(200);
      expect((list.body as EventRow[]).map((e) => e.id)).toEqual([fair]);
      await http.get(`/api/orgs/events-itpo/events/${fair}`).set(auth(organiser)).expect(200);
      await http.get(`/api/orgs/events-itpo/events/${bookFair}`).set(auth(organiser)).expect(404);
    });

    it('keeps creating events and booking halls to the whole organisation', async () => {
      const body = {
        venueId,
        name: 'Own Event',
        kind: 'external',
        eventType: 'B2B',
        startsOn: '2027-07-01',
        endsOn: '2027-07-02',
      };
      await http.post('/api/orgs/events-itpo/events').set(auth(organiser)).send(body).expect(403);
      const refused = await http
        .post('/api/orgs/events-itpo/events')
        .set(auth(manager))
        .send(body)
        .expect(403);
      expect(refused.body.message).toBe('Only members of the whole organisation can do this.');
      await http
        .put(`/api/orgs/events-itpo/events/${fair}/halls/${hall2}`)
        .set(auth(manager))
        .expect(403);
      await http
        .patch(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(manager))
        .send({ venueId: annexId })
        .expect(403);
      await http.delete(`/api/orgs/events-itpo/events/${fair}`).set(auth(manager)).expect(403);
      // The hall options name other events holding the halls, which it may not see.
      const craft = (
        await event({ name: 'Craft Mela', startsOn: '2027-02-12', endsOn: '2027-02-13' }).expect(
          201,
        )
      ).body.id;
      await http
        .put(`/api/orgs/events-itpo/events/${craft}/halls/${hall2}`)
        .set(auth(owner))
        .expect(200);
      const options = await http
        .get(`/api/orgs/events-itpo/events/${fair}/hall-options`)
        .set(auth(manager))
        .expect(403);
      expect(options.body.message).toBe('Only members of the whole organisation can do this.');

      // Its own event's details it may change; another event it cannot even see.
      await http
        .patch(`/api/orgs/events-itpo/events/${fair}`)
        .set(auth(manager))
        .send({ organiserPhone: '+91 11 2337 1540' })
        .expect(200);
      await http
        .patch(`/api/orgs/events-itpo/events/${bookFair}`)
        .set(auth(manager))
        .send({ organiserPhone: '+91 11 2337 1540' })
        .expect(404);
    });

    it('keeps other organisations out', async () => {
      await http.get('/api/orgs/events-itpo/events').set(auth(outsider)).expect(403);
      await http.get(`/api/orgs/events-jio/events/${fair}`).set(auth(outsider)).expect(404);
    });

    it('records the changes in the audit log', async () => {
      const res = await http.get('/api/orgs/events-itpo/audit?pageSize=100').set(auth(owner));
      const actions = new Set(res.body.items.map((e: { action: string }) => e.action));
      for (const action of [
        'event.created',
        'event.updated',
        'event.hall_added',
        'event.hall_removed',
        'event.status_changed',
        'event.deleted',
      ]) {
        expect(actions).toContain(action);
      }
    });
  });
});
