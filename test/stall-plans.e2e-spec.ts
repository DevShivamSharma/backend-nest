import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MailMessage, MailService } from '../src/mail/mail.service';
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

  function rates(more: Record<string, unknown> = {}) {
    return {
      bareRate: 8000,
      shellRate: 9500,
      side2Percent: 5,
      side3Percent: 10,
      side4Percent: 15,
      catalogueCharge: 5000,
      fnbPrice: null,
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
      updated: 0,
      linked: 0,
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
  it('sends an external event’s plan to the venue for approval, and emails each answer', async () => {
    // The plan's emails; invitations go by too.
    const sent: MailMessage[] = [];
    const spy = jest.spyOn(app.get(MailService), 'send').mockImplementation(async (m) => {
      if (m.subject.startsWith('Stall plan')) sent.push(m);
    });
    const roles = (await http.get(`${base}/roles`).set(auth(owner))).body;
    const invited = await http
      .post(`${base}/events/${expo}/people`)
      .set(auth(owner))
      .send({
        email: 'admin@expo.test',
        roleId: roles.find((r: { key: string }) => r.key === 'organiser_admin').id,
      })
      .expect(201);
    const lead = await accept(invited.body.invitation.inviteUrl, 'Expo Lead', 'expo-lead-pass-1');

    // The organiser cannot publish an external event's plan before the venue approves it; they
    // send it for approval.
    const opened = await http.get(plan(expo)).set(auth(lead)).expect(200);
    expect(opened.body).toMatchObject({
      canPublish: false,
      needsApproval: true,
      canSubmit: true,
      canApprove: false,
    });
    const early = await http
      .post(`${plan(expo)}/publish`)
      .set(auth(lead))
      .send({ revision: 1 })
      .expect(400);
    expect(early.body.message).toBe('Version 1 is not approved. Send it for approval first.');
    // Every stall for sale needs a price before the plan goes.
    const unpriced = await http
      .post(`${plan(expo)}/submit`)
      .set(auth(lead))
      .send({ revision: 1 })
      .expect(400);
    expect(unpriced.body.message).toBe(
      'The plan was not sent: 1 stall for sale has no price: B-1. Price it first.',
    );
    await http
      .put(`${plan(expo)}/pricing/card`)
      .set(auth(lead))
      .send({ general: rates() })
      .expect(200);
    const submitted = await http
      .post(`${plan(expo)}/submit`)
      .set(auth(lead))
      .send({ revision: 1 })
      .expect(200);
    expect(submitted.body.review).toMatchObject({
      status: 'submitted',
      revision: 1,
      submittedBy: 'Expo Lead',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@sp-itpo.test']);
    expect(sent[0].subject).toBe('Stall plan for approval: Expo, Hall 5');
    expect(sent[0].text).toContain('Expo Lead (Expo Co) sent the stall plan of Hall 5');
    expect(sent[0].text).toContain(`/sp-itpo/events/${expo}/halls/${hall}/planner`);

    // While it waits, the organiser cannot change it; the venue may answer.
    const waiting = await http.get(plan(expo)).set(auth(lead)).expect(200);
    expect(waiting.body).toMatchObject({ canEdit: false, canSubmit: false, canWithdraw: true });
    expect(waiting.body.readOnlyReason).toMatch(/sent to Org sp for approval/);
    await http
      .put(plan(expo))
      .set(auth(lead))
      .send({ revision: 1, zones: [], stalls: [], seats: [], objects: [] })
      .expect(403);
    await http
      .post(`${plan(expo)}/approve`)
      .set(auth(lead))
      .send({ revision: 1 })
      .expect(403);
    const venue = await http.get(plan(expo)).set(auth(owner)).expect(200);
    expect(venue.body.canApprove).toBe(true);
    // The venue sees what the saved plan breaks; the organiser is not given it.
    expect(venue.body.findings).toEqual([]);
    expect(waiting.body.findings).toBeNull();

    // Sent back, with what to change: the sender and the event's drawers are told.
    await http
      .post(`${plan(expo)}/reject`)
      .set(auth(owner))
      .send({ revision: 1 })
      .expect(400);
    const rejected = await http
      .post(`${plan(expo)}/reject`)
      .set(auth(owner))
      .send({ revision: 1, note: 'Leave 3 m in front of the fire exit.' })
      .expect(200);
    expect(rejected.body.review).toMatchObject({
      status: 'rejected',
      reviewedBy: 'Ops',
      note: 'Leave 3 m in front of the fire exit.',
    });
    expect(rejected.body.published).toBeNull();
    expect(sent).toHaveLength(2);
    expect([sent[1].to].flat().sort()).toEqual(['admin@expo.test', 'architect@expo.test']);
    expect(sent[1].subject).toBe('Stall plan sent back: Expo, Hall 5');
    expect(sent[1].text).toContain('Leave 3 m in front of the fire exit.');

    // Changed, sent again, approved: approval lets the organiser publish; nothing is published yet.
    await http
      .put(plan(expo))
      .set(auth(lead))
      .send({ revision: 1, zones: [], stalls: [stall('1', 14, 10)], seats: [], objects: [] })
      .expect(200);
    await http
      .post(`${plan(expo)}/submit`)
      .set(auth(lead))
      .send({ revision: 2 })
      .expect(200);
    await http
      .post(`${plan(expo)}/approve`)
      .set(auth(owner))
      .send({ revision: 1 })
      .expect(409);
    const approved = await http
      .post(`${plan(expo)}/approve`)
      .set(auth(owner))
      .send({ revision: 2 })
      .expect(200);
    expect(approved.body.review).toMatchObject({ status: 'approved', revision: 2 });
    expect(approved.body.published).toBeNull();
    expect(sent.map((m) => m.subject).slice(2)).toEqual([
      'Stall plan for approval: Expo, Hall 5',
      'Stall plan approved: Expo, Hall 5',
    ]);
    expect(sent[3].text).toContain('Publish it from the planner when you are ready');
    // Approved and unchanged: nothing to send; the organiser publishes, the venue does not.
    await http
      .post(`${plan(expo)}/submit`)
      .set(auth(lead))
      .send({ revision: 2 })
      .expect(400);
    const ready = await http.get(plan(expo)).set(auth(lead)).expect(200);
    expect(ready.body).toMatchObject({ canPublish: true, canSubmit: false, canEdit: true });
    expect((await http.get(plan(expo)).set(auth(owner))).body.canPublish).toBe(false);
    await http
      .post(`${plan(expo)}/publish`)
      .set(auth(owner))
      .send({ revision: 2 })
      .expect(403);
    // Approval does not waive the prices: a card taken away after approval stops the publish,
    // and putting it back lets it through.
    await http
      .put(`${plan(expo)}/pricing/card`)
      .set(auth(lead))
      .send({})
      .expect(200);
    const unpricedAtPublish = await http
      .post(`${plan(expo)}/publish`)
      .set(auth(lead))
      .send({ revision: 2 })
      .expect(400);
    expect(unpricedAtPublish.body.message).toBe(
      'The plan was not published: 1 stall for sale has no price: B-1. Price it first.',
    );
    await http
      .put(`${plan(expo)}/pricing/card`)
      .set(auth(lead))
      .send({ general: rates() })
      .expect(200);
    const published = await http
      .post(`${plan(expo)}/publish`)
      .set(auth(lead))
      .send({ revision: 2 })
      .expect(200);
    expect(published.body.published).toMatchObject({ revision: 2 });
    expect(published.body.review).toMatchObject({ status: 'approved', revision: 2 });
    expect((await http.get(plan(expo)).set(auth(lead))).body.canPublish).toBe(false);

    // A plan sent by mistake is withdrawn, and can be changed again.
    await http
      .put(plan(expo))
      .set(auth(lead))
      .send({ revision: 2, zones: [], stalls: [stall('1', 18, 10)], seats: [], objects: [] })
      .expect(200);
    // Saved as version 3, which nobody approved: the organiser may not publish it, and is
    // offered to send it instead, though version 2 was approved and published.
    const unapproved = await http
      .post(`${plan(expo)}/publish`)
      .set(auth(lead))
      .send({ revision: 3 })
      .expect(400);
    expect(unapproved.body.message).toBe('Version 3 is not approved. Send it for approval first.');
    expect((await http.get(plan(expo)).set(auth(lead))).body).toMatchObject({
      canPublish: false,
      canSubmit: true,
    });
    await http
      .post(`${plan(expo)}/submit`)
      .set(auth(lead))
      .send({ revision: 3 })
      .expect(200);
    const back = await http
      .post(`${plan(expo)}/withdraw`)
      .set(auth(lead))
      .expect(200);
    expect(back.body.review).toBeNull();
    expect(back.body.published).toMatchObject({ revision: 2 });
    expect((await http.get(plan(expo)).set(auth(lead))).body.canEdit).toBe(true);
    // Withdrawn, version 3 is still not approved: Publish stays off and Send is offered again.
    expect((await http.get(plan(expo)).set(auth(lead))).body).toMatchObject({
      canPublish: false,
      canSubmit: true,
    });
    // Internal events are published, not sent.
    await http
      .post(`${plan(fair)}/submit`)
      .set(auth(owner))
      .send({ revision: 1 })
      .expect(400);
    spy.mockRestore();
  });
  it('prices stalls by the hall’s rate card and on single stalls, by the team that plans them', async () => {
    const roles = (await http.get(`${base}/roles`).set(auth(owner))).body;
    // The venue prices its internal event.
    const opened = await http.get(plan(fair)).set(auth(owner)).expect(200);
    expect(opened.body.pricing).toEqual({
      card: null,
      prices: [],
      canManage: true,
      readOnlyReason: null,
    });
    await http
      .put(`${plan(fair)}/pricing/card`)
      .set(auth(owner))
      .send({ general: rates({ side2Percent: -1 }) })
      .expect(400);
    const card = await http
      .put(`${plan(fair)}/pricing/card`)
      .set(auth(owner))
      .send({ general: rates(), premium: rates({ shellRate: 12000 }), marquee: null })
      .expect(200);
    expect(card.body.card).toEqual({
      general: rates(),
      premium: rates({ shellRate: 12000 }),
      marquee: null,
    });

    // A price on one stall, then taken off again.
    const stalls = opened.body.plan.stalls as Array<{ id: string }>;
    expect(stalls.length).toBeGreaterThan(0);
    const [first] = stalls;
    const set = await http
      .put(`${plan(fair)}/pricing/stalls`)
      .set(auth(owner))
      .send({ prices: [{ stallId: first.id, price: 150000, note: '  Agreed with the buyer ' }] })
      .expect(200);
    expect(set.body.prices).toEqual([
      { stallId: first.id, price: 150000, note: 'Agreed with the buyer' },
    ]);
    const off = await http
      .put(`${plan(fair)}/pricing/stalls`)
      .set(auth(owner))
      .send({ prices: [{ stallId: first.id, price: null }] })
      .expect(200);
    expect(off.body.prices).toEqual([]);

    // A stall's price goes when a save leaves the stall out.
    await http
      .put(`${plan(fair)}/pricing/stalls`)
      .set(auth(owner))
      .send({ prices: [{ stallId: first.id, price: 1000 }] })
      .expect(200);
    const kept = await http.get(plan(fair)).set(auth(owner));
    await http
      .put(plan(fair))
      .set(auth(owner))
      .send({
        revision: kept.body.plan.revision,
        zones: [],
        stalls: [stall('77', 30, 20)],
        seats: [],
        objects: [],
      })
      .expect(200);
    expect((await http.get(plan(fair)).set(auth(owner))).body.pricing.prices).toEqual([]);

    // The venue sees the external event's prices, but the organiser sets them.
    const venue = await http.get(plan(expo)).set(auth(owner)).expect(200);
    expect(venue.body.pricing).toMatchObject({ canManage: false });
    expect(venue.body.pricing.readOnlyReason).toMatch(/Expo Co prices the stalls/);
    await http
      .put(`${plan(expo)}/pricing/card`)
      .set(auth(owner))
      .send({ general: rates() })
      .expect(403);
    // An organiser's architect draws but does not see prices.
    expect(roles.find((r: { key: string }) => r.key === 'organiser_architect')).toBeDefined();
    const architect = await http.get(plan(expo)).set(auth(organiser)).expect(200);
    expect(architect.body.pricing).toBeNull();
    await http
      .put(`${plan(expo)}/pricing/stalls`)
      .set(auth(organiser))
      .send({ prices: [] })
      .expect(403);
  });

  it("keeps the categories in step with SelfCare's list, by SelfCare's ids", async () => {
    const sync = (rows: Array<{ name: string; status?: string; itpoId: string }>) =>
      http.post(`${base}/categories/import`).set(auth(owner)).send({ rows }).expect(200);
    const listed = async () =>
      (await http.get(`${base}/categories`).set(auth(owner))).body as Array<{
        name: string;
        status: string;
        itpoId: string | null;
      }>;
    // A long SelfCare name is kept whole; Corner, already listed, is linked rather than doubled.
    const food =
      'Processed Food, Organic Food, Beverages, Ingredients, Dairy Products, Spices and Agri Produce';
    const first = await sync([
      { name: food, itpoId: '85' },
      { name: 'Corner', itpoId: '86' },
      { name: 'Refrigeration', status: 'inactive', itpoId: '91' },
      { name: 'Twice', itpoId: '91' },
    ]);
    expect(first.body).toEqual({
      created: 2,
      updated: 0,
      linked: 1,
      skipped: [{ name: 'Twice', reason: 'Twice in the file' }],
    });
    // Again, with a name and a status SelfCare changed: the same categories take them.
    const again = await sync([
      { name: food, itpoId: '85' },
      { name: 'Corner stall', itpoId: '86' },
      { name: 'Refrigeration', itpoId: '91' },
    ]);
    expect(again.body).toEqual({ created: 0, updated: 2, linked: 0, skipped: [] });
    const byId = (id: string) => listed().then((l) => l.find((c) => c.itpoId === id));
    expect(await byId('85')).toMatchObject({ name: food, status: 'active' });
    expect(await byId('86')).toMatchObject({ name: 'Corner stall' });
    expect(await byId('91')).toMatchObject({ name: 'Refrigeration', status: 'active' });
    expect((await listed()).find((c) => c.name === 'Corner')).toBeUndefined();
  });
});
