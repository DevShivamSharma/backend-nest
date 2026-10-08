import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

const UNKNOWN_ID = '7d3f9a52-1b8e-4c2a-9f0e-2a1b3c4d5e6f';

interface StallRow {
  id: string;
  number: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: string[];
}

/** A 3 x 3 m stall open to the front, in a row along y = 10. */
const stall = (number: string, x: number, id?: string) => ({
  ...(id ? { id } : {}),
  number,
  x,
  y: 10,
  width: 3,
  depth: 3,
  openSides: ['bottom'],
});

/**
 * Stall plans end to end: one plan per hall of an event, saved whole at the revision it was
 * opened at, approved once it passes the rules (or sets them aside with reasons), published to
 * booking and reopened; drafts are seen only by those who draw, approve or publish plans.
 */
describe('Stall plans (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let architect: string;
  let exhibitor: string;
  let viewer: string;
  let organisationId: string;
  let hall1: string;
  let hall2: string;
  let hall3: string;
  let fair: string;
  let expo: string;

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

  /** Invites a person with the role (and scope) and returns their token once they accept. */
  async function member(email: string, roleId: string, scope: object = {}) {
    const invited = await http
      .post('/api/orgs/plans-itpo/invitations')
      .set(auth(owner))
      .send({ email, roleId, ...scope })
      .expect(201);
    const accepted = await http
      .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
      .send({ name: email, password: 'member-password-1' })
      .expect(200);
    return accepted.body.accessToken as string;
  }

  const planUrl = (hallId: string, eventId = fair) =>
    `/api/orgs/plans-itpo/events/${eventId}/halls/${hallId}/plan`;

  const save = (hallId: string, body: object, token = owner, eventId = fair) =>
    http.put(planUrl(hallId, eventId)).set(auth(token)).send(body);

  const step = (hallId: string, action: string, revision: number, token = owner) =>
    http
      .post(`${planUrl(hallId)}/${action}`)
      .set(auth(token))
      .send({ revision });

  const byNumber = (stalls: StallRow[]) =>
    Object.fromEntries(stalls.map((s) => [s.number, s])) as Record<string, StallRow>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const itpo = await organisation('plans-itpo', 'ops@plans-itpo.test');
    organisationId = itpo.id;
    owner = itpo.token;

    // Three empty 40 x 30 m halls; the fair books two of them, the expo the third.
    const venueId = (
      await http
        .post('/api/orgs/plans-itpo/venues')
        .set(auth(owner))
        .send({ name: 'Bharat Mandapam' })
        .expect(201)
    ).body.id;
    const hall = async (name: string) =>
      (
        await http
          .post(`/api/orgs/plans-itpo/venues/${venueId}/halls`)
          .set(auth(owner))
          .send({ name, width: 40, depth: 30 })
          .expect(201)
      ).body.id as string;
    hall1 = await hall('Hall 1');
    hall2 = await hall('Hall 2');
    hall3 = await hall('Hall 3');
    const event = async (name: string, startsOn: string, endsOn: string, halls: string[]) => {
      const id = (
        await http
          .post('/api/orgs/plans-itpo/events')
          .set(auth(owner))
          .send({ venueId, name, kind: 'internal', eventType: 'B2B', startsOn, endsOn })
          .expect(201)
      ).body.id as string;
      for (const hallId of halls) {
        await http
          .put(`/api/orgs/plans-itpo/events/${id}/halls/${hallId}`)
          .set(auth(owner))
          .expect(200);
      }
      return id;
    };
    fair = await event('India International Trade Fair', '2027-02-10', '2027-02-14', [
      hall1,
      hall2,
    ]);
    expo = await event('Auto Expo', '2027-03-01', '2027-03-03', [hall3]);

    const roles = Object.fromEntries(
      (
        (await http.get('/api/orgs/plans-itpo/roles').set(auth(owner)).expect(200)).body as Array<{
          id: string;
          key: string;
        }>
      ).map((role) => [role.key, role.id]),
    );
    const exhibitorId = (
      await http
        .post('/api/orgs/plans-itpo/exhibitors')
        .set(auth(owner))
        .send({ name: 'Tata Motors', eventId: fair })
        .expect(201)
    ).body.id;
    architect = await member('architect@plans-itpo.test', roles.organiser_architect, {
      eventIds: [fair],
    });
    exhibitor = await member('exhibitor@plans-itpo.test', roles.exhibitor, {
      eventIds: [fair],
      exhibitorId,
    });
    // A role that may only look at plans: published ones.
    const role = await http
      .post('/api/admin/roles')
      .set(auth(root))
      .send({
        organisationId,
        key: 'plan_viewer',
        name: 'Plan viewer',
        scopeKind: 'organisation',
        permissions: ['layouts.view'],
      })
      .expect(201);
    viewer = await member('viewer@plans-itpo.test', role.body.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows a hall without a plan as an empty draft on the booked floor', async () => {
    const res = await http.get(planUrl(hall1)).set(auth(owner)).expect(200);
    expect(res.body).toMatchObject({
      id: null,
      status: 'draft',
      revision: 0,
      stalls: [],
      overrides: [],
      activeBookings: 0,
      event: { id: fair, eventType: 'B2B', status: 'draft' },
      hall: { id: hall1, name: 'Hall 1', floorVersion: 1, currentVersion: 1 },
      floor: { width: 40, depth: 30 },
      report: { passed: true, violations: [] },
    });

    const other = await http.get(planUrl(hall3)).set(auth(owner)).expect(404);
    expect(other.body.message).toBe('The event does not book this hall.');
    const unpublished = await http.get(planUrl(hall1)).set(auth(viewer)).expect(404);
    expect(unpublished.body.message).toBe('No stall plan has been published for this hall yet.');
  });

  it('creates the plan on the first save and refuses a stale or malformed one', async () => {
    const res = await save(hall1, {
      revision: 0,
      stalls: [stall('A1', 10), stall('A2', 13)],
    }).expect(200);
    expect(res.body).toMatchObject({ status: 'draft', revision: 1 });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.stalls.map((s: StallRow) => s.number)).toEqual(['A1', 'A2']);
    expect(res.body.stalls[0]).toMatchObject({ x: 10, y: 10, area: 9, stallType: null });
    expect(res.body.report.passed).toBe(true);

    const stale = await save(hall1, { revision: 0, stalls: [] }).expect(409);
    expect(stale.body.message).toBe('The plan changed since you opened it. Reload it first.');
    const twice = await save(hall1, {
      revision: 1,
      stalls: [stall('A1', 10), stall('A1', 20)],
    }).expect(400);
    expect(twice.body.message).toBe('Stall number A1 appears twice.');
    const foreign = await save(hall1, {
      revision: 1,
      stalls: [stall('B9', 20, UNKNOWN_ID)],
    }).expect(400);
    expect(foreign.body.message).toBe('Stall B9 is not part of this plan.');
    await save(hall1, { revision: 1, stalls: [{ ...stall('A1', 10), width: 0 }] }).expect(400);
    await save(hall1, { revision: 1, stalls: [{ ...stall('A1', 10), openSides: ['up'] }] }).expect(
      400,
    );
  });

  it('swaps two stall numbers in one save', async () => {
    const current = byNumber((await http.get(planUrl(hall1)).set(auth(owner))).body.stalls);
    const res = await save(hall1, {
      revision: 1,
      stalls: [stall('A2', 10, current.A1.id), stall('A1', 13, current.A2.id)],
    }).expect(200);
    expect(res.body.revision).toBe(2);
    const swapped = byNumber(res.body.stalls);
    expect(swapped.A2.id).toBe(current.A1.id);
    expect(swapped.A1.id).toBe(current.A2.id);
  });

  it('lets an organiser architect draw its event’s plans but not approve them', async () => {
    const current = byNumber((await http.get(planUrl(hall1)).set(auth(architect))).body.stalls);
    const res = await save(
      hall1,
      {
        revision: 2,
        stalls: [stall('A2', 10, current.A2.id), stall('A1', 13, current.A1.id), stall('A3', 16)],
      },
      architect,
    ).expect(200);
    expect(res.body).toMatchObject({ revision: 3 });
    expect(res.body.stalls).toHaveLength(3);

    await step(hall1, 'approve', 3, architect).expect(403);
    await http.get(planUrl(hall3, expo)).set(auth(architect)).expect(404);
    await save(hall3, { revision: 0, stalls: [] }, architect, expo).expect(404);
  });

  it('approves only a draft with stalls that passes the rules or sets them aside', async () => {
    await save(hall2, { revision: 0, stalls: [] }).expect(200);
    const empty = await step(hall2, 'approve', 1).expect(409);
    expect(empty.body.message).toBe('Draw at least one stall first.');

    const overlapping = await save(hall2, {
      revision: 1,
      stalls: [stall('B1', 10), stall('B2', 12)],
    }).expect(200);
    expect(overlapping.body.report.passed).toBe(false);
    expect(overlapping.body.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain(
      'stallOverlap',
    );
    const blocked = await step(hall2, 'approve', 2).expect(409);
    expect(blocked.body.message).toMatch(/^The plan breaks \d+ rule check\(s\)/);
    await step(hall2, 'approve', 1).expect(409);
    await step(hall2, 'approve', 0).expect(400);

    const ids = byNumber(overlapping.body.stalls);
    const stalls = [stall('B1', 10, ids.B1.id), stall('B2', 12, ids.B2.id)];
    const unknown = await save(hall2, {
      revision: 2,
      stalls,
      overrides: [{ ruleId: 'stallOverlap', stallIds: [UNKNOWN_ID], reason: 'Joint stand' }],
    }).expect(400);
    expect(unknown.body.message).toMatch(/names a stall that is not in the plan/);
    await save(hall2, {
      revision: 2,
      stalls,
      overrides: [{ ruleId: 'stallOverlap', stallIds: [ids.B1.id, ids.B2.id], reason: '' }],
    }).expect(400);

    const overridden = await save(hall2, {
      revision: 2,
      stalls,
      overrides: [
        {
          ruleId: 'stallOverlap',
          stallIds: [ids.B1.id, ids.B2.id],
          reason: 'One exhibitor, joint stand',
        },
      ],
    }).expect(200);
    expect(overridden.body.report.passed).toBe(true);
    expect(overridden.body.overrides).toEqual([
      {
        ruleId: 'stallOverlap',
        stallIds: [ids.B1.id, ids.B2.id],
        reason: 'One exhibitor, joint stand',
        by: 'ops@plans-itpo.test',
      },
    ]);

    const approved = await step(hall2, 'approve', 3).expect(200);
    expect(approved.body).toMatchObject({ status: 'approved', revision: 4 });
    expect(approved.body.approvedAt).toEqual(expect.any(String));
  });

  it('publishes only an approved plan, which those who only look then see', async () => {
    const early = await step(hall1, 'publish', 3).expect(409);
    expect(early.body.message).toBe('Approve the plan before publishing it.');
    await step(hall1, 'approve', 3).expect(200);
    const frozen = await save(hall1, { revision: 4, stalls: [] }).expect(409);
    expect(frozen.body.message).toMatch(/Reopen it first/);
    await http.get(planUrl(hall1)).set(auth(viewer)).expect(404);

    const published = await step(hall1, 'publish', 4).expect(200);
    expect(published.body).toMatchObject({ status: 'published', revision: 5 });
    expect(published.body.publishedAt).toEqual(expect.any(String));
    await step(hall1, 'publish', 5).expect(409);

    for (const token of [viewer, exhibitor]) {
      const seen = await http.get(planUrl(hall1)).set(auth(token)).expect(200);
      expect(seen.body).toMatchObject({ status: 'published', revision: 5 });
      expect(seen.body.stalls).toHaveLength(3);
    }
    await save(hall1, { revision: 5, stalls: [] }, viewer).expect(403);
  });

  it('summarises the plans of an event as far as the member may see them', async () => {
    const res = await http
      .get(`/api/orgs/plans-itpo/events/${fair}/plans`)
      .set(auth(owner))
      .expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        hallId: hall1,
        hallName: 'Hall 1',
        status: 'published',
        revision: 5,
        stallCount: 3,
        activeBookings: 0,
      }),
      expect.objectContaining({ hallId: hall2, status: 'approved', revision: 4, stallCount: 2 }),
    ]);

    const seen = await http
      .get(`/api/orgs/plans-itpo/events/${fair}/plans`)
      .set(auth(viewer))
      .expect(200);
    expect(seen.body[0]).toMatchObject({ hallId: hall1, status: 'published', stallCount: 3 });
    expect(seen.body[1]).toEqual({
      hallId: hall2,
      hallName: 'Hall 2',
      planId: null,
      status: null,
      revision: 0,
      stallCount: 0,
      activeBookings: 0,
    });
    await http.get(`/api/orgs/plans-itpo/events/${expo}/plans`).set(auth(exhibitor)).expect(404);
  });

  it('reopens a plan for changes, out of sight of those who only look', async () => {
    await step(hall1, 'reopen', 5, exhibitor).expect(403);
    const reopened = await step(hall1, 'reopen', 5).expect(200);
    expect(reopened.body).toMatchObject({
      status: 'draft',
      revision: 6,
      approvedAt: null,
      publishedAt: null,
    });
    const again = await step(hall1, 'reopen', 6).expect(409);
    expect(again.body.message).toBe('The plan is already a draft.');
    await http.get(planUrl(hall1)).set(auth(viewer)).expect(404);
  });

  it('keeps the event type while a plan checked against it is approved', async () => {
    const res = await http
      .patch(`/api/orgs/plans-itpo/events/${fair}`)
      .set(auth(owner))
      .send({ eventType: 'B2C' })
      .expect(409);
    expect(res.body.message).toMatch(/Reopen its plans before changing the event type/);
  });

  it('deletes a draft plan, so the hall can leave the event', async () => {
    const booked = await http
      .delete(`/api/orgs/plans-itpo/events/${fair}/halls/${hall1}`)
      .set(auth(owner))
      .expect(409);
    expect(booked.body.message).toBe('The hall has a stall plan. Delete the plan first.');
    const approved = await http.delete(planUrl(hall2)).set(auth(owner)).expect(409);
    expect(approved.body.message).toBe('Reopen the plan before deleting it.');

    await http.delete(planUrl(hall1)).set(auth(owner)).expect(204);
    const empty = await http.get(planUrl(hall1)).set(auth(owner)).expect(200);
    expect(empty.body).toMatchObject({ id: null, revision: 0, stalls: [] });
    const gone = await http.delete(planUrl(hall1)).set(auth(owner)).expect(404);
    expect(gone.body.message).toBe('This hall has no stall plan yet.');

    const withPlans = await http
      .delete(`/api/orgs/plans-itpo/events/${fair}`)
      .set(auth(owner))
      .expect(409);
    expect(withPlans.body.message).toMatch(/has stall plans or bookings/);
    await http
      .delete(`/api/orgs/plans-itpo/events/${fair}/halls/${hall1}`)
      .set(auth(owner))
      .expect(204);
  });

  it('freezes the plans of a cancelled event', async () => {
    await http
      .post(`/api/orgs/plans-itpo/events/${expo}/status`)
      .set(auth(owner))
      .send({ status: 'cancelled' })
      .expect(200);
    const res = await save(hall3, { revision: 0, stalls: [stall('C1', 10)] }, owner, expo).expect(
      409,
    );
    expect(res.body.message).toBe('A cancelled event cannot change.');
  });

  it('records the plan changes in the audit log', async () => {
    const res = await http.get('/api/orgs/plans-itpo/audit?pageSize=100').set(auth(owner));
    const actions = new Set(res.body.items.map((e: { action: string }) => e.action));
    for (const action of [
      'stall_plan.saved',
      'stall_plan.approved',
      'stall_plan.published',
      'stall_plan.reopened',
      'stall_plan.deleted',
    ]) {
      expect(actions).toContain(action);
    }
  });
});
