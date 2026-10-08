import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

const UNKNOWN_ID = '7d3f9a52-1b8e-4c2a-9f0e-2a1b3c4d5e6f';

interface ExhibitorRow {
  id: string;
  name: string;
  eventIds: string[];
}

/**
 * Exhibitors end to end: the companies of an organisation that take stalls, unique by name,
 * registered per event; event-scoped members work only with the exhibitors of their events.
 */
describe('Exhibitors (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let outsider: string;
  let architect: string;
  let roles: Record<string, string>;
  let fair: string;
  let expo: string;
  let tentative: string;
  let tata: string;
  let mahindra: string;

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

  /** Invites a person with the role (and events) and returns their token once they accept. */
  async function member(email: string, roleId: string, eventIds?: string[]) {
    const invited = await http
      .post('/api/orgs/exh-itpo/invitations')
      .set(auth(owner))
      .send({ email, roleId, ...(eventIds ? { eventIds } : {}) })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: email, password: 'member-password-1' })
      .expect(200);
    return accepted.body.accessToken as string;
  }

  const create = (body: object, token = owner) =>
    http.post('/api/orgs/exh-itpo/exhibitors').set(auth(token)).send(body);

  const names = (rows: ExhibitorRow[]) => rows.map((row) => row.name);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    owner = (await organisation('exh-itpo', 'ops@exh-itpo.test')).token;
    outsider = (await organisation('exh-jio', 'ops@exh-jio.test')).token;

    const venueId = (
      await http
        .post('/api/orgs/exh-itpo/venues')
        .set(auth(owner))
        .send({ name: 'Bharat Mandapam' })
        .expect(201)
    ).body.id;
    const event = async (name: string, startsOn: string, endsOn: string) =>
      (
        await http
          .post('/api/orgs/exh-itpo/events')
          .set(auth(owner))
          .send({ venueId, name, kind: 'internal', eventType: 'B2B', startsOn, endsOn })
          .expect(201)
      ).body.id as string;
    fair = await event('India International Trade Fair', '2027-02-10', '2027-02-14');
    expo = await event('Auto Expo', '2027-03-01', '2027-03-03');
    tentative = await event('Tentative Show', '2027-04-01', '2027-04-03');
    await http
      .post(`/api/orgs/exh-itpo/events/${tentative}/status`)
      .set(auth(owner))
      .send({ status: 'cancelled' })
      .expect(200);

    const res = await http.get('/api/orgs/exh-itpo/roles').set(auth(owner)).expect(200);
    roles = Object.fromEntries(
      (res.body as Array<{ id: string; key: string }>).map((role) => [role.key, role.id]),
    );
    architect = await member('architect@exh-itpo.test', roles.venue_architect);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('exhibitors', () => {
    it('creates an exhibitor with a valid GSTIN and a name of its own', async () => {
      const res = await create({
        name: 'Tata Motors',
        contactName: 'R. Mehta',
        email: 'Sales@Tata.test',
        phone: '+91 22 6665 8282',
        gstin: '27AAACT2727Q1ZW',
        address: 'Bombay House, Mumbai',
      }).expect(201);
      tata = res.body.id;
      expect(res.body).toMatchObject({
        name: 'Tata Motors',
        email: 'sales@tata.test',
        gstin: '27AAACT2727Q1ZW',
        eventIds: [],
      });

      await create({ name: 'Short GSTIN', gstin: '27AAACT2727Q1Z' }).expect(400);
      await create({ name: 'Lower GSTIN', gstin: '27aaact2727q1zw' }).expect(400);
      await create({ name: ' ' }).expect(400);
      await create({ name: 'Extra', website: 'https://tata.test' }).expect(400);
      const taken = await create({ name: 'TATA MOTORS' }).expect(409);
      expect(taken.body.message).toBe('There is already an exhibitor called "Tata Motors".');
    });

    it('registers a new exhibitor for an open event at once', async () => {
      const res = await create({ name: 'Mahindra', eventId: fair }).expect(201);
      mahindra = res.body.id;
      expect(res.body.eventIds).toEqual([fair]);

      const closed = await create({ name: 'Too Late', eventId: tentative }).expect(409);
      expect(closed.body.message).toBe('A cancelled event cannot change.');
      await create({ name: 'Nowhere', eventId: UNKNOWN_ID }).expect(404);
    });

    it('lists and shows exhibitors, also by event', async () => {
      const all = await http.get('/api/orgs/exh-itpo/exhibitors').set(auth(owner)).expect(200);
      expect(names(all.body)).toEqual(['Mahindra', 'Tata Motors']);
      const atFair = await http
        .get(`/api/orgs/exh-itpo/exhibitors?eventId=${fair}`)
        .set(auth(owner))
        .expect(200);
      expect(names(atFair.body)).toEqual(['Mahindra']);
      await http
        .get(`/api/orgs/exh-itpo/exhibitors?eventId=${UNKNOWN_ID}`)
        .set(auth(owner))
        .expect(404);

      const one = await http
        .get(`/api/orgs/exh-itpo/exhibitors/${tata}`)
        .set(auth(owner))
        .expect(200);
      expect(one.body).toMatchObject({ id: tata, contactName: 'R. Mehta' });
      await http.get(`/api/orgs/exh-itpo/exhibitors/${UNKNOWN_ID}`).set(auth(owner)).expect(404);
    });

    it('updates an exhibitor, keeping names unique', async () => {
      const url = `/api/orgs/exh-itpo/exhibitors/${tata}`;
      await http.patch(url).set(auth(owner)).send({ name: 'mahindra' }).expect(409);
      await http.patch(url).set(auth(owner)).send({ gstin: 'not-a-gstin' }).expect(400);
      const res = await http
        .patch(url)
        .set(auth(owner))
        .send({ name: 'TATA Motors', phone: '' })
        .expect(200);
      expect(res.body).toMatchObject({ name: 'TATA Motors', phone: null });
      await http.patch(url).set(auth(owner)).send({ name: 'Tata Motors' }).expect(200);
    });

    it('registers an exhibitor for an event and takes it off again', async () => {
      const at = (event: string, exhibitor = tata) =>
        `/api/orgs/exh-itpo/events/${event}/exhibitors/${exhibitor}`;
      const registered = await http.put(at(fair)).set(auth(owner)).expect(200);
      expect(registered.body.eventIds).toEqual([fair]);
      // Registering it again changes nothing.
      await http.put(at(fair)).set(auth(owner)).expect(200);
      const both = await http.put(at(expo)).set(auth(owner)).expect(200);
      expect([...both.body.eventIds].sort()).toEqual([fair, expo].sort());

      await http.delete(at(expo)).set(auth(owner)).expect(204);
      const gone = await http.delete(at(expo)).set(auth(owner)).expect(404);
      expect(gone.body.message).toBe('Tata Motors is not registered for this event.');

      const closed = await http.put(at(tentative)).set(auth(owner)).expect(409);
      expect(closed.body.message).toBe('A cancelled event cannot change.');
      await http.put(at(fair, UNKNOWN_ID)).set(auth(owner)).expect(404);
      await http.put(at(UNKNOWN_ID)).set(auth(owner)).expect(404);
    });

    it('deletes only an exhibitor registered for no event', async () => {
      const refused = await http
        .delete(`/api/orgs/exh-itpo/exhibitors/${tata}`)
        .set(auth(owner))
        .expect(409);
      expect(refused.body.message).toBe(
        'Tata Motors is registered for 1 event(s). Remove it from them first.',
      );

      const bajaj = (await create({ name: 'Bajaj Auto' }).expect(201)).body.id;
      await http.delete(`/api/orgs/exh-itpo/exhibitors/${bajaj}`).set(auth(owner)).expect(204);
      await http.get(`/api/orgs/exh-itpo/exhibitors/${bajaj}`).set(auth(owner)).expect(404);
    });
  });

  describe('event scope', () => {
    let organiser: string;
    let hero: string;
    let expoOnly: string;

    beforeAll(async () => {
      organiser = await member('organiser@exh-itpo.test', roles.organiser_admin, [fair]);
    });

    it('makes an event-scoped member name the event of a new exhibitor', async () => {
      const none = await create({ name: 'Hero MotoCorp' }, organiser).expect(400);
      expect(none.body.message).toBe('Choose the event the new exhibitor takes part in.');
      await create({ name: 'Hero MotoCorp', eventId: expo }, organiser).expect(404);

      const res = await create({ name: 'Hero MotoCorp', eventId: fair }, organiser).expect(201);
      hero = res.body.id;
      expect(res.body.eventIds).toEqual([fair]);
    });

    it('shows an event-scoped member only the exhibitors of its events', async () => {
      await http
        .put(`/api/orgs/exh-itpo/events/${expo}/exhibitors/${mahindra}`)
        .set(auth(owner))
        .expect(200);
      expoOnly = (await create({ name: 'Maruti Suzuki', eventId: expo }).expect(201)).body.id;

      const list = await http.get('/api/orgs/exh-itpo/exhibitors').set(auth(organiser)).expect(200);
      expect(names(list.body)).toEqual(['Hero MotoCorp', 'Mahindra', 'Tata Motors']);
      // Only the events it works on are shown.
      const seen = (list.body as ExhibitorRow[]).find((row) => row.id === mahindra)!;
      expect(seen.eventIds).toEqual([fair]);

      await http.get(`/api/orgs/exh-itpo/exhibitors/${expoOnly}`).set(auth(organiser)).expect(404);
      await http
        .patch(`/api/orgs/exh-itpo/exhibitors/${expoOnly}`)
        .set(auth(organiser))
        .send({ contactName: 'Someone' })
        .expect(404);
      await http
        .get(`/api/orgs/exh-itpo/exhibitors?eventId=${expo}`)
        .set(auth(organiser))
        .expect(404);
      await http
        .put(`/api/orgs/exh-itpo/events/${expo}/exhibitors/${hero}`)
        .set(auth(organiser))
        .expect(404);
    });

    it('lets it take an exhibitor off its event, but not delete one', async () => {
      const refused = await http
        .delete(`/api/orgs/exh-itpo/exhibitors/${hero}`)
        .set(auth(organiser))
        .expect(403);
      expect(refused.body.message).toBe('Only members of the whole organisation can do this.');

      await http
        .delete(`/api/orgs/exh-itpo/events/${fair}/exhibitors/${hero}`)
        .set(auth(organiser))
        .expect(204);
      await http.get(`/api/orgs/exh-itpo/exhibitors/${hero}`).set(auth(organiser)).expect(404);
      await http.delete(`/api/orgs/exh-itpo/exhibitors/${hero}`).set(auth(owner)).expect(204);
    });

    it('keeps exhibitors to members who see bookings, in their organisation', async () => {
      await http.get('/api/orgs/exh-itpo/exhibitors').set(auth(architect)).expect(403);
      await http.get('/api/orgs/exh-itpo/exhibitors').set(auth(outsider)).expect(403);
      await http.get(`/api/orgs/exh-jio/exhibitors/${tata}`).set(auth(outsider)).expect(404);
    });

    it('records the changes in the audit log', async () => {
      const res = await http.get('/api/orgs/exh-itpo/audit?pageSize=100').set(auth(owner));
      const actions = new Set(res.body.items.map((e: { action: string }) => e.action));
      for (const action of [
        'exhibitor.created',
        'exhibitor.updated',
        'exhibitor.registered',
        'exhibitor.unregistered',
        'exhibitor.deleted',
      ]) {
        expect(actions).toContain(action);
      }
    });
  });
});
