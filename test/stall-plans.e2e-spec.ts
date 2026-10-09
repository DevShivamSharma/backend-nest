import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

/**
 * Module E end to end: the organisation's stall categories (one by one and from a CSV), the
 * categories an event hall sells, and the stall plan of an event hall — checked against the
 * hall's rules, saved whole, and drawn only by the team the event's kind names.
 */
describe('Stall planning (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let owner: string;
  let organiser: string;
  let hall: string;
  let fair: string;
  let expo: string;
  let premium: string;
  let corner: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = '/api/orgs/sp-itpo';
  const plan = (event: string) => `${base}/events/${event}/halls/${hall}/plan`;

  function stall(number: string, x: number, y: number, more: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      zoneId: null,
      islandNumber: 'B-',
      stallNumber: number,
      x,
      y,
      width: 3,
      depth: 3,
      openSides: ['bottom'],
      scheme: 'shell',
      categoryIds: [],
      isPremium: false,
      isBlocked: false,
      isFnb: false,
      isBranding: false,
      isHorseshoe: false,
      isMarqueeAvailable: false,
      isRestrictedForOverseas: false,
      isActive: true,
      location: null,
      description: null,
      ...more,
    };
  }

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
    const root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const org = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: 'Org sp', slug: 'sp-itpo', firstAdmin: { email: 'ops@sp-itpo.test' } })
      .expect(201);
    owner = await accept(org.body.invitation.inviteUrl, 'Ops', 'owner-password-1');
    const venue = await http.post(`${base}/venues`).set(auth(owner)).send({ name: 'Pragati' });
    hall = (
      await http
        .post(`${base}/venues/${venue.body.id}/halls`)
        .set(auth(owner))
        .send({ name: 'Hall 5', width: 40, depth: 30 })
        .expect(201)
    ).body.id;
    // Only the rules these tests are about.
    await http
      .patch(`${base}/rules`)
      .set(auth(owner))
      .send({
        switches: { cornerKeepOut: false, peripheralClearance: false, maxUtilization: false },
      })
      .expect(200);
    const event = (body: Record<string, unknown>) =>
      http
        .post(`${base}/events`)
        .set(auth(owner))
        .send({ audience: 'B2B', startsOn: '2026-11-14', endsOn: '2026-11-20', ...body })
        .expect(201);
    fair = (await event({ kind: 'internal', name: 'IITF' })).body.id;
    expo = (await event({ kind: 'external', name: 'Expo', organiserName: 'Expo Co' })).body.id;
    for (const id of [fair, expo]) {
      await http
        .post(`${base}/events/${id}/halls`)
        .set(auth(owner))
        .send({ hallIds: [hall] });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps categories one by one and from a CSV, names once per organisation', async () => {
    premium = (
      await http.post(`${base}/categories`).set(auth(owner)).send({ name: 'Premium' }).expect(201)
    ).body.id;
    await http.post(`${base}/categories`).set(auth(owner)).send({ name: 'premium' }).expect(409);
    const imported = await http
      .post(`${base}/categories/import`)
      .set(auth(owner))
      .send({
        rows: [
          { name: 'Corner' },
          { name: 'PREMIUM' },
          { name: 'Pavilion', status: 'inactive' },
          { name: 'corner' },
        ],
      })
      .expect(200);
    expect(imported.body).toEqual({
      created: 2,
      skipped: [
        { name: 'PREMIUM', reason: 'Already listed' },
        { name: 'corner', reason: 'Twice in the file' },
      ],
    });
    const list = await http.get(`${base}/categories`).set(auth(owner)).expect(200);
    expect(list.body.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
      ['Corner', 'active'],
      ['Pavilion', 'inactive'],
      ['Premium', 'active'],
    ]);
    corner = list.body[0].id;
  });

  it('lets an event hall sell active categories, and keeps those in use', async () => {
    const pavilion = (await http.get(`${base}/categories`).set(auth(owner))).body[1].id;
    const inactive = await http
      .put(`${base}/events/${fair}/halls/${hall}/categories`)
      .set(auth(owner))
      .send({ categoryIds: [pavilion] });
    expect(inactive.status).toBe(400);
    expect(inactive.body.message).toMatch(/inactive/);
    const set = await http
      .put(`${base}/events/${fair}/halls/${hall}/categories`)
      .set(auth(owner))
      .send({ categoryIds: [premium, corner] })
      .expect(200);
    expect(set.body.categories.map((c: { name: string }) => c.name)).toEqual(['Corner', 'Premium']);
    // Sold on a hall: switched off, not deleted.
    await http.delete(`${base}/categories/${premium}`).set(auth(owner)).expect(409);
  });

  it('refuses a change that breaks a rule, and saves a plan that breaks none', async () => {
    const opened = await http.get(plan(fair)).set(auth(owner)).expect(200);
    expect(opened.body).toMatchObject({ canEdit: true, plan: { revision: 0, stalls: [] } });

    const a = stall('1', 5, 5, { categoryIds: [premium] });
    const overlapping = stall('2', 6, 6);
    const check = await http
      .post(`${plan(fair)}/check`)
      .set(auth(owner))
      .send({
        zones: [],
        stalls: [a, overlapping],
        seats: [],
        objects: [],
        changed: [overlapping.id],
      })
      .expect(200);
    expect(check.body.findings.map((f: { ruleId: string }) => f.ruleId)).toContain('stallOverlap');

    const outside = await http
      .put(plan(fair))
      .set(auth(owner))
      .send({ revision: 0, zones: [], stalls: [a, stall('3', 39, 5)], seats: [], objects: [] });
    expect(outside.status).toBe(400);
    expect(outside.body.message).toMatch(/not saved: Stall B-3 reaches past/);

    const zone = {
      id: randomUUID(),
      name: 'Zone A',
      color: '#3b82f6',
      polygon: [
        [0, 0],
        [20, 0],
        [20, 15],
        [0, 15],
      ],
    };
    const seat = {
      id: randomUUID(),
      zoneId: null,
      rowLabel: 'A',
      seatNumber: 1,
      x: 30,
      y: 20,
      width: 0.5,
      depth: 0.5,
      categoryId: corner,
    };
    const saved = await http
      .put(plan(fair))
      .set(auth(owner))
      .send({
        revision: 0,
        zones: [zone],
        stalls: [{ ...a, zoneId: zone.id }],
        seats: [seat],
        objects: [],
      })
      .expect(200);
    expect(saved.body).toMatchObject({ revision: 1, zones: [{ area: 300 }] });
    expect(saved.body.stalls[0]).toMatchObject({ islandNumber: 'B-', stallNumber: '1' });

    // Someone else's save in between: refused, nothing lost.
    await http
      .put(plan(fair))
      .set(auth(owner))
      .send({ revision: 0, zones: [], stalls: [], seats: [], objects: [] })
      .expect(409);

    // A category a stall uses stays on the hall.
    const inUse = await http
      .put(`${base}/events/${fair}/halls/${hall}/categories`)
      .set(auth(owner))
      .send({ categoryIds: [corner] });
    expect(inUse.status).toBe(409);
    expect(inUse.body.message).toMatch(/Premium/);
    const detail = await http.get(`${base}/events/${fair}/halls/${hall}`).set(auth(owner));
    expect(detail.body.plan).toEqual({ stalls: 1, seats: 1, revision: 1 });
  });

  it('publishes the saved plan, and only that revision', async () => {
    const opened = await http.get(plan(fair)).set(auth(owner)).expect(200);
    expect(opened.body).toMatchObject({ canPublish: true, plan: { revision: 1, published: null } });
    await http
      .post(`${plan(fair)}/publish`)
      .set(auth(owner))
      .send({ revision: 2 })
      .expect(409);
    const published = await http
      .post(`${plan(fair)}/publish`)
      .set(auth(owner))
      .send({ revision: 1 })
      .expect(200);
    expect(published.body.published).toMatchObject({ revision: 1 });
    const again = await http.get(plan(fair)).set(auth(owner)).expect(200);
    expect(again.body.plan.published.revision).toBe(1);
  });

  it('lets only the organiser draw an external event; the venue reads it', async () => {
    const invited = await http
      .post(`${base}/events/${expo}/people`)
      .set(auth(owner))
      .send({
        email: 'architect@expo.test',
        roleId: (await http.get(`${base}/roles`).set(auth(owner))).body.find(
          (r: { key: string }) => r.key === 'organiser_architect',
        ).id,
      })
      .expect(201);
    organiser = await accept(invited.body.invitation.inviteUrl, 'Architect', 'architect-pass-1');

    const venueView = await http.get(plan(expo)).set(auth(owner)).expect(200);
    expect(venueView.body).toMatchObject({ canEdit: false });
    expect(venueView.body.readOnlyReason).toMatch(/Expo Co plans/);
    await http
      .put(plan(expo))
      .set(auth(owner))
      .send({ revision: 0, zones: [], stalls: [], seats: [], objects: [] })
      .expect(403);

    const mine = await http.get(plan(expo)).set(auth(organiser)).expect(200);
    expect(mine.body.canEdit).toBe(true);
    await http
      .put(plan(expo))
      .set(auth(organiser))
      .send({ revision: 0, zones: [], stalls: [stall('1', 10, 10)], seats: [], objects: [] })
      .expect(200);
    // An architect draws; publishing is the organiser admin's.
    expect(mine.body.canPublish).toBe(false);
    await http
      .post(`${plan(expo)}/publish`)
      .set(auth(organiser))
      .send({ revision: 1 })
      .expect(403);
    // Not their event, not their plan.
    await http.get(plan(fair)).set(auth(organiser)).expect(404);
    // Categories are the venue's.
    await http.get(`${base}/categories`).set(auth(organiser)).expect(403);
  });
});
