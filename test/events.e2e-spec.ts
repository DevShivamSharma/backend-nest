import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

/**
 * Module D end to end: internal and external events, their halls (floor version and rules
 * copied, overlaps), and organisers who see only their own events.
 */
describe('Events (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let hallA: string;
  let hallB: string;
  let fair: string;
  let expo: string;
  let organiserRole: string;
  let architectRole: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = '/api/orgs/ev-itpo';

  async function accept(inviteUrl: string, name: string, password: string): Promise<string> {
    const res = await http
      .post(`/api/auth/invitations/${tokenFrom(inviteUrl)}/accept`)
      .send({ name, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const org = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: 'Org ev', slug: 'ev-itpo', firstAdmin: { email: 'ops@ev-itpo.test' } })
      .expect(201);
    owner = await accept(org.body.invitation.inviteUrl, 'Ops', 'owner-password-1');

    const venue = await http.post(`${base}/venues`).set(auth(owner)).send({ name: 'Pragati' });
    const hall = (name: string) =>
      http
        .post(`${base}/venues/${venue.body.id}/halls`)
        .set(auth(owner))
        .send({ name, width: 40, depth: 30 })
        .expect(201);
    hallA = (await hall('Hall 5')).body.id;
    hallB = (await hall('Hall 6')).body.id;

    const roles = await http.get(`${base}/roles`).set(auth(owner)).expect(200);
    const byKey = (key: string) => roles.body.find((r: { key: string }) => r.key === key).id;
    organiserRole = byKey('organiser_admin');
    architectRole = byKey('organiser_architect');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates internal and external events, checking dates and the organiser', async () => {
    const internal = await http
      .post(`${base}/events`)
      .set(auth(owner))
      .send({
        kind: 'internal',
        name: 'IITF 2026',
        venueEventId: 'HB-1001',
        audience: 'B2C',
        startsOn: '2026-11-14',
        endsOn: '2026-11-27',
        buildUpOn: '2026-11-08',
      })
      .expect(201);
    fair = internal.body.id;
    expect(internal.body).toMatchObject({
      kind: 'internal',
      organiserName: null,
      startsOn: '2026-11-14',
      buildUpOn: '2026-11-08',
      hallCount: 0,
    });

    const external = {
      kind: 'external',
      name: 'Footwear Expo',
      audience: 'B2B',
      startsOn: '2026-11-20',
      endsOn: '2026-11-22',
    };
    const noOrganiser = await http.post(`${base}/events`).set(auth(owner)).send(external);
    expect(noOrganiser.status).toBe(400);
    expect(noOrganiser.body.message).toMatch(/organiser/);
    expo = (
      await http
        .post(`${base}/events`)
        .set(auth(owner))
        .send({ ...external, organiserName: 'Expo Co' })
        .expect(201)
    ).body.id;

    const backwards = await http
      .post(`${base}/events`)
      .set(auth(owner))
      .send({ ...external, organiserName: 'X', startsOn: '2026-11-22', endsOn: '2026-11-20' });
    expect(backwards.body.message).toMatch(/ends before it starts/);
    const notADay = await http
      .post(`${base}/events`)
      .set(auth(owner))
      .send({ ...external, organiserName: 'X', endsOn: '2026-11-31' });
    expect(notADay.body.message).toMatch(/not a real date/);
    await http
      .post(`${base}/events`)
      .set(auth(owner))
      .send({ ...external, organiserName: 'X', venueEventId: 'HB-1001' })
      .expect(409);

    const list = await http.get(`${base}/events?kind=external`).set(auth(owner)).expect(200);
    expect(list.body.map((e: { name: string }) => e.name)).toEqual(['Footwear Expo']);
  });

  it('adds halls on their current floor with the rules of the day, and shows overlaps', async () => {
    await http
      .patch(`${base}/rules`)
      .set(auth(owner))
      .send({ switches: { cornerKeepOut: false }, drawingProfile: 'grid' })
      .expect(200);
    const added = await http
      .post(`${base}/events/${fair}/halls`)
      .set(auth(owner))
      .send({ hallIds: [hallA, hallB] })
      .expect(201);
    expect(added.body.halls).toHaveLength(2);
    expect(added.body.halls[0]).toMatchObject({
      name: 'Hall 5',
      floorVersion: 1,
      drawingProfile: 'grid',
      overlaps: [],
    });
    await http
      .post(`${base}/events/${fair}/halls`)
      .set(auth(owner))
      .send({ hallIds: [hallA] })
      .expect(409);

    // Later changes to the organisation's rules do not reach the event's hall.
    await http
      .patch(`${base}/rules`)
      .set(auth(owner))
      .send({ switches: { cornerKeepOut: true } })
      .expect(200);
    const hall = await http
      .get(`${base}/events/${fair}/halls/${hallA}`)
      .set(auth(owner))
      .expect(200);
    expect(hall.body.rules.switches.cornerKeepOut).toBe(false);
    expect(hall.body.floor.width).toBe(40);

    const switched = await http
      .patch(`${base}/events/${fair}/halls/${hallA}/rules`)
      .set(auth(owner))
      .send({ switches: { ...hall.body.rules.switches, stallOverlap: false } })
      .expect(200);
    expect(switched.body.rules.switches.stallOverlap).toBe(false);
    const reset = await http
      .post(`${base}/events/${fair}/halls/${hallA}/rules/reset`)
      .set(auth(owner))
      .expect(200);
    expect(reset.body.rules.switches).toMatchObject({ stallOverlap: true, cornerKeepOut: true });

    const expoHalls = await http
      .post(`${base}/events/${expo}/halls`)
      .set(auth(owner))
      .send({ hallIds: [hallA] })
      .expect(201);
    expect(expoHalls.body.halls[0].overlaps).toEqual([
      expect.objectContaining({ name: 'IITF 2026' }),
    ]);

    // A hall in use is not deleted.
    const refused = await http.delete(`${base}/halls/${hallA}`).set(auth(owner)).expect(409);
    expect(refused.body.message).toMatch(/used by the event/);
  });

  it('invites organisers to external events only, scoped to that event', async () => {
    await http
      .post(`${base}/events/${fair}/people`)
      .set(auth(owner))
      .send({ email: 'org@expo.test', roleId: organiserRole })
      .expect(400);
    // Event roles are not given from the team page.
    await http
      .post(`${base}/invitations`)
      .set(auth(owner))
      .send({ email: 'org@expo.test', roleId: organiserRole })
      .expect(403);

    const invited = await http
      .post(`${base}/events/${expo}/people`)
      .set(auth(owner))
      .send({ email: 'org@expo.test', roleId: organiserRole })
      .expect(201);
    expect(invited.body.added).toBe(false);
    const organiser = await accept(
      invited.body.invitation.inviteUrl,
      'Expo Organiser',
      'organiser-pass-1',
    );

    const context = await http.get(`${base}/context`).set(auth(organiser)).expect(200);
    expect(context.body.membership).toMatchObject({
      eventScoped: true,
      scope: { eventIds: [expo] },
    });

    // Only their event, and nothing outside events.
    const list = await http.get(`${base}/events`).set(auth(organiser)).expect(200);
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([expo]);
    await http.get(`${base}/events/${fair}`).set(auth(organiser)).expect(404);
    await http.get(`${base}/venues`).set(auth(organiser)).expect(403);
    await http.get(`${base}/rules`).set(auth(organiser)).expect(403);
    await http.get(`${base}/rules/catalogue`).set(auth(organiser)).expect(200);
    const hall = await http
      .get(`${base}/events/${expo}/halls/${hallA}`)
      .set(auth(organiser))
      .expect(200);
    expect(hall.body.hall.overlaps).toEqual([]);
    await http
      .patch(`${base}/events/${expo}/halls/${hallA}/rules`)
      .set(auth(organiser))
      .send({ switches: {} })
      .expect(403);
  });

  it('adds a second event to an organiser, and removes it again', async () => {
    const second = (
      await http
        .post(`${base}/events`)
        .set(auth(owner))
        .send({
          kind: 'external',
          name: 'Leather Fair',
          organiserName: 'Expo Co',
          audience: 'B2B',
          startsOn: '2027-02-01',
          endsOn: '2027-02-03',
        })
        .expect(201)
    ).body.id;
    await http
      .post(`${base}/events/${second}/people`)
      .set(auth(owner))
      .send({ email: 'org@expo.test', roleId: architectRole })
      .expect(409);
    const added = await http
      .post(`${base}/events/${second}/people`)
      .set(auth(owner))
      .send({ email: 'org@expo.test', roleId: organiserRole })
      .expect(201);
    expect(added.body).toEqual({ added: true, invitation: null });

    const organiser = (await login(app, 'org@expo.test', 'organiser-pass-1')).token;
    const list = await http.get(`${base}/events`).set(auth(organiser)).expect(200);
    expect(list.body).toHaveLength(2);

    const people = await http.get(`${base}/events/${second}/people`).set(auth(owner)).expect(200);
    const member = people.body.members[0];
    await http.delete(`${base}/events/${second}/people/${member.id}`).set(auth(owner)).expect(204);
    const after = await http.get(`${base}/events`).set(auth(organiser)).expect(200);
    expect(after.body.map((e: { id: string }) => e.id)).toEqual([expo]);

    // Deleting their last event takes away their access to the organisation.
    await http.delete(`${base}/events/${expo}`).set(auth(owner)).expect(204);
    await http.get(`${base}/events`).set(auth(organiser)).expect(403);
    const audit = await http.get(`${base}/audit`).set(auth(owner)).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['event.created', 'event.halls_added', 'event.deleted']),
    );
  });
});
