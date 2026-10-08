import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

const UNKNOWN_ID = '7d3f9a52-1b8e-4c2a-9f0e-2a1b3c4d5e6f';

interface RoleRow {
  id: string;
  key: string;
  assignable: boolean;
  reason: string | null;
}

interface MemberRow {
  id: string;
  user: { email: string };
  role: { key: string };
  scope: { eventIds?: string[]; exhibitorId?: string };
}

/**
 * Event-scoped roles end to end: they can be given once the organisation has a live event, for
 * chosen events (and, for those who book stalls, an exhibitor registered for them), and an
 * event-scoped member sees and acts on the team of its own events only.
 */
describe('Team with event roles (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let organisationId: string;
  let venueId: string;
  let roles: Record<string, RoleRow>;
  let fair: string;
  let expo: string;
  let tentative: string;
  let exhibitorId: string;
  let organiser: string;

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

  const invite = (token: string, body: object) =>
    http.post('/api/orgs/team-itpo/invitations').set(auth(token)).send(body);

  /** Invites a person, lets them accept, and returns their token. */
  async function member(
    inviter: string,
    body: { email: string; roleId: string; eventIds?: string[]; exhibitorId?: string },
  ) {
    const invited = await invite(inviter, body).expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: body.email, password: 'member-password-1' })
      .expect(200);
    return accepted.body.accessToken as string;
  }

  async function listRoles(token: string) {
    const res = await http.get('/api/orgs/team-itpo/roles').set(auth(token)).expect(200);
    return Object.fromEntries((res.body as RoleRow[]).map((role) => [role.key, role]));
  }

  async function members(token: string) {
    const res = await http.get('/api/orgs/team-itpo/members').set(auth(token)).expect(200);
    return res.body as MemberRow[];
  }

  const memberId = async (email: string) =>
    (await members(owner)).find((m) => m.user.email === email)!.id;

  const event = (name: string, startsOn: string, endsOn: string) =>
    http
      .post('/api/orgs/team-itpo/events')
      .set(auth(owner))
      .send({ venueId, name, kind: 'internal', eventType: 'B2B', startsOn, endsOn })
      .expect(201);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const itpo = await organisation('team-itpo', 'ops@team-itpo.test');
    organisationId = itpo.id;
    owner = itpo.token;
    venueId = (
      await http
        .post('/api/orgs/team-itpo/venues')
        .set(auth(owner))
        .send({ name: 'Bharat Mandapam' })
        .expect(201)
    ).body.id;

    // A whole-organisation role an organiser admin holds every permission of, and an event
    // role that may also manage the team.
    for (const role of [
      {
        key: 'team_reader',
        name: 'Team reader',
        scopeKind: 'organisation',
        permissions: ['team.view'],
      },
      {
        key: 'event_team_lead',
        name: 'Event team lead',
        scopeKind: 'event',
        permissions: [
          'team.view',
          'team.invite',
          'team.manage',
          'venues.view',
          'rules.view',
          'events.view',
          'layouts.view',
          'layouts.edit',
        ],
      },
    ]) {
      await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({ organisationId, ...role })
        .expect(201);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('offers event roles only while the organisation has a live event', async () => {
    roles = await listRoles(owner);
    expect(roles.organiser_admin).toMatchObject({
      assignable: false,
      reason: 'Event roles can be given once the event exists.',
    });
    const early = await invite(owner, {
      email: 'early@team-itpo.test',
      roleId: roles.organiser_admin.id,
      eventIds: [UNKNOWN_ID],
    }).expect(403);
    expect(early.body.message).toBe('Event roles can be given once the event exists.');

    tentative = (await event('Tentative Show', '2027-01-10', '2027-01-12')).body.id;
    expect((await listRoles(owner)).organiser_admin.assignable).toBe(true);
    await http
      .post(`/api/orgs/team-itpo/events/${tentative}/status`)
      .set(auth(owner))
      .send({ status: 'cancelled' })
      .expect(200);
    expect((await listRoles(owner)).organiser_admin.assignable).toBe(false);

    fair = (await event('India International Trade Fair', '2027-02-10', '2027-02-14')).body.id;
    expo = (await event('Auto Expo', '2027-03-01', '2027-03-03')).body.id;
    roles = await listRoles(owner);
    for (const key of ['organiser_admin', 'organiser_architect', 'exhibitor', 'venue_architect']) {
      expect(roles[key]).toMatchObject({ assignable: true, reason: null });
    }
  });

  it('gives an event role for the chosen live events of the organisation', async () => {
    const none = await invite(owner, {
      email: 'organiser@team-itpo.test',
      roleId: roles.organiser_admin.id,
    }).expect(400);
    expect(none.body.message).toBe('Choose the events this person works on.');
    const unknown = await invite(owner, {
      email: 'organiser@team-itpo.test',
      roleId: roles.organiser_admin.id,
      eventIds: [UNKNOWN_ID],
    }).expect(400);
    expect(unknown.body.message).toBe('Some of these events are not in this organisation.');
    const cancelled = await invite(owner, {
      email: 'organiser@team-itpo.test',
      roleId: roles.organiser_admin.id,
      eventIds: [tentative],
    }).expect(400);
    expect(cancelled.body.message).toBe('Tentative Show is cancelled.');
    const whole = await invite(owner, {
      email: 'architect@team-itpo.test',
      roleId: roles.venue_architect.id,
      eventIds: [fair],
    }).expect(400);
    expect(whole.body.message).toBe(
      'A whole-organisation role is not limited to events or an exhibitor.',
    );
    const notBooking = await invite(owner, {
      email: 'architect@team-itpo.test',
      roleId: roles.organiser_architect.id,
      eventIds: [fair],
      exhibitorId: UNKNOWN_ID,
    }).expect(400);
    expect(notBooking.body.message).toBe('Only a role that books stalls acts for an exhibitor.');

    const invited = await invite(owner, {
      email: 'organiser@team-itpo.test',
      roleId: roles.organiser_admin.id,
      eventIds: [fair],
    }).expect(201);
    expect(invited.body).toMatchObject({
      role: { key: 'organiser_admin' },
      scope: { eventIds: [fair] },
    });
    organiser = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
        .send({ name: 'organiser@team-itpo.test', password: 'member-password-1' })
        .expect(200)
    ).body.accessToken;
    const context = await http.get('/api/orgs/team-itpo/context').set(auth(organiser)).expect(200);
    expect(context.body.membership).toMatchObject({
      role: { key: 'organiser_admin' },
      scope: { eventIds: [fair] },
    });
  });

  it('gives the exhibitor role for an exhibitor registered for every chosen event', async () => {
    const body = { email: 'exhibitor@team-itpo.test', roleId: roles.exhibitor.id };
    const noExhibitor = await invite(owner, { ...body, eventIds: [fair] }).expect(400);
    expect(noExhibitor.body.message).toBe('Choose the exhibitor this person books stalls for.');
    const unknown = await invite(owner, {
      ...body,
      eventIds: [fair],
      exhibitorId: UNKNOWN_ID,
    }).expect(400);
    expect(unknown.body.message).toBe('There is no such exhibitor in this organisation.');

    exhibitorId = (
      await http
        .post('/api/orgs/team-itpo/exhibitors')
        .set(auth(owner))
        .send({ name: 'Tata Motors', eventId: fair })
        .expect(201)
    ).body.id;
    const unregistered = await invite(owner, {
      ...body,
      eventIds: [fair, expo],
      exhibitorId,
    }).expect(400);
    expect(unregistered.body.message).toBe('Register Tata Motors for Auto Expo first.');

    const invited = await invite(owner, { ...body, eventIds: [fair], exhibitorId }).expect(201);
    expect(invited.body.scope).toEqual({ eventIds: [fair], exhibitorId });
    await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: 'exhibitor@team-itpo.test', password: 'member-password-1' })
      .expect(200);
  });

  it('lets an event-scoped member give event roles within its own events only', async () => {
    const offered = await listRoles(organiser);
    expect(offered.venue_architect).toMatchObject({
      assignable: false,
      reason: 'You can give only event roles, for your own events.',
    });
    expect(offered.organiser_architect).toMatchObject({ assignable: true, reason: null });
    expect(offered.exhibitor).toMatchObject({
      assignable: false,
      reason: 'This role has permissions you do not have.',
    });

    const body = { email: 'architect@team-itpo.test', roleId: roles.organiser_architect.id };
    const other = await invite(organiser, { ...body, eventIds: [expo] }).expect(403);
    expect(other.body.message).toBe('You can give access only to your own events.');
    await invite(organiser, { ...body, eventIds: [fair, expo] }).expect(403);
    const whole = await invite(organiser, {
      email: 'reader@team-itpo.test',
      roleId: roles.team_reader.id,
    }).expect(403);
    expect(whole.body.message).toBe('You can give only event roles, for your own events.');

    await member(organiser, { ...body, eventIds: [fair] });
  });

  it('lists only the members and invitations of its own events', async () => {
    await member(owner, {
      email: 'expo-architect@team-itpo.test',
      roleId: roles.organiser_architect.id,
      eventIds: [expo],
    });
    await invite(owner, {
      email: 'both@team-itpo.test',
      roleId: roles.organiser_architect.id,
      eventIds: [fair, expo],
    }).expect(201);
    await invite(owner, {
      email: 'venue-architect@team-itpo.test',
      roleId: roles.venue_architect.id,
    }).expect(201);
    await invite(organiser, {
      email: 'pending@team-itpo.test',
      roleId: roles.organiser_architect.id,
      eventIds: [fair],
    }).expect(201);

    const seen = (await members(organiser)).map((m) => m.user.email).sort();
    expect(seen).toEqual([
      'architect@team-itpo.test',
      'exhibitor@team-itpo.test',
      'organiser@team-itpo.test',
    ]);
    const invitations = await http
      .get('/api/orgs/team-itpo/invitations')
      .set(auth(organiser))
      .expect(200);
    expect(invitations.body.map((i: { email: string }) => i.email)).toEqual([
      'pending@team-itpo.test',
    ]);

    expect(await members(owner)).toHaveLength(5);
    const all = await http.get('/api/orgs/team-itpo/invitations').set(auth(owner)).expect(200);
    expect(all.body).toHaveLength(3);
  });

  it('changes a role, keeping the events or checking the new ones', async () => {
    const id = await memberId('architect@team-itpo.test');
    const url = `/api/orgs/team-itpo/members/${id}`;

    const kept = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.organiser_admin.id })
      .expect(200);
    expect(kept.body).toMatchObject({
      role: { key: 'organiser_admin' },
      scope: { eventIds: [fair] },
    });
    const both = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.organiser_architect.id, eventIds: [fair, expo] })
      .expect(200);
    expect(both.body.scope).toEqual({ eventIds: [fair, expo] });

    const noExhibitor = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.exhibitor.id })
      .expect(400);
    expect(noExhibitor.body.message).toBe('Choose the exhibitor this person books stalls for.');
    const unregistered = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.exhibitor.id, exhibitorId })
      .expect(400);
    expect(unregistered.body.message).toBe('Register Tata Motors for Auto Expo first.');

    // To the whole organisation: the events no longer apply.
    const whole = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.venue_architect.id })
      .expect(200);
    expect(whole.body).toMatchObject({ role: { key: 'venue_architect' }, scope: {} });

    // And back to an event role, which needs its events again.
    const noEvents = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.organiser_architect.id })
      .expect(400);
    expect(noEvents.body.message).toBe('Choose the events this person works on.');
    const back = await http
      .patch(url)
      .set(auth(owner))
      .send({ roleId: roles.organiser_architect.id, eventIds: [fair] })
      .expect(200);
    expect(back.body.scope).toEqual({ eventIds: [fair] });

    // A whole-organisation role that books stalls leaves the exhibitor behind too.
    const promoted = await http
      .patch(`/api/orgs/team-itpo/members/${await memberId('exhibitor@team-itpo.test')}`)
      .set(auth(owner))
      .send({ roleId: roles.venue_admin.id })
      .expect(200);
    expect(promoted.body).toMatchObject({ role: { key: 'venue_admin' }, scope: {} });
  });

  it('keeps an event-scoped manager to the team of its own events', async () => {
    const lead = await member(owner, {
      email: 'lead@team-itpo.test',
      roleId: roles.event_team_lead.id,
      eventIds: [fair],
    });
    const expoArchitect = `/api/orgs/team-itpo/members/${await memberId('expo-architect@team-itpo.test')}`;
    const architect = `/api/orgs/team-itpo/members/${await memberId('architect@team-itpo.test')}`;
    const ownerUrl = `/api/orgs/team-itpo/members/${await memberId('ops@team-itpo.test')}`;

    const outside = await http
      .patch(expoArchitect)
      .set(auth(lead))
      .send({ roleId: roles.organiser_architect.id })
      .expect(403);
    expect(outside.body.message).toBe('This member works on events you do not work on.');
    await http.delete(expoArchitect).set(auth(lead)).expect(403);
    const higher = await http.delete(ownerUrl).set(auth(lead)).expect(403);
    expect(higher.body.message).toBe('This member has permissions you do not have.');

    const moved = await http
      .patch(architect)
      .set(auth(lead))
      .send({ roleId: roles.organiser_architect.id, eventIds: [expo] })
      .expect(403);
    expect(moved.body.message).toBe('You can give access only to your own events.');
    await http
      .patch(architect)
      .set(auth(lead))
      .send({ roleId: roles.organiser_architect.id, eventIds: [fair] })
      .expect(200);

    const invitations = (
      await http.get('/api/orgs/team-itpo/invitations').set(auth(owner)).expect(200)
    ).body as Array<{ id: string; email: string }>;
    const idOf = (email: string) => invitations.find((i) => i.email === email)!.id;
    const refused = await http
      .delete(`/api/orgs/team-itpo/invitations/${idOf('both@team-itpo.test')}`)
      .set(auth(lead))
      .expect(403);
    expect(refused.body.message).toBe('This invitation is for events you do not work on.');
    // Inviting is not managing: the organiser admin cannot revoke at all.
    await http
      .delete(`/api/orgs/team-itpo/invitations/${idOf('pending@team-itpo.test')}`)
      .set(auth(organiser))
      .expect(403);
    await http
      .delete(`/api/orgs/team-itpo/invitations/${idOf('pending@team-itpo.test')}`)
      .set(auth(lead))
      .expect(204);

    await http.delete(architect).set(auth(lead)).expect(204);
  });

  it('records the events given in the audit log', async () => {
    const res = await http.get('/api/orgs/team-itpo/audit?pageSize=100').set(auth(owner));
    const created = res.body.items.find(
      (e: { action: string; metadata: { email?: string } }) =>
        e.action === 'invitation.created' && e.metadata.email === 'exhibitor@team-itpo.test',
    );
    expect(created.metadata).toMatchObject({ role: 'exhibitor', eventIds: [fair], exhibitorId });
  });
});
