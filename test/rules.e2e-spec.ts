import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

/**
 * Module C end to end: an organisation's rules (the standard ones to start, values within
 * limits, read only without rules.manage), and checking stalls on a real hall's floor with
 * overrides and the drawing profile.
 */
describe('Rules (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let viewer: string;
  let outsider: string;
  let hallId: string;

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

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const itpo = await organisation('rules-itpo', 'ops@rules-itpo.test');
    owner = itpo.token;
    outsider = (await organisation('rules-jio', 'ops@rules-jio.test')).token;

    const role = await http
      .post('/api/admin/roles')
      .set(auth(root))
      .send({
        organisationId: itpo.id,
        key: 'rule_reader',
        name: 'Rule reader',
        scopeKind: 'organisation',
        permissions: ['rules.view', 'venues.view'],
      })
      .expect(201);
    const invited = await http
      .post('/api/orgs/rules-itpo/invitations')
      .set(auth(owner))
      .send({ email: 'reader@rules-itpo.test', roleId: role.body.id })
      .expect(201);
    viewer = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
        .send({ name: 'Reader', password: 'reader-password-1' })
        .expect(200)
    ).body.accessToken;

    // A 40 x 30 m hall with a compulsory passage along its top.
    const venue = await http
      .post('/api/orgs/rules-itpo/venues')
      .set(auth(owner))
      .send({ name: 'Test venue' })
      .expect(201);
    hallId = (
      await http
        .post(`/api/orgs/rules-itpo/venues/${venue.body.id}/halls`)
        .set(auth(owner))
        .send({ name: 'Hall R', width: 40, depth: 30 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the rule catalogue, with rules waiting for data marked', async () => {
    const res = await http
      .get('/api/orgs/rules-itpo/rules/catalogue')
      .set(auth(viewer))
      .expect(200);
    expect(res.body.rules).toHaveLength(17);
    expect(res.body.rules.find((r: { id: string }) => r.id === 'internalZones')).toMatchObject({
      available: false,
    });
    expect(res.body.profiles.map((p: { id: string }) => p.id)).toEqual(['free', 'grid']);
  });

  it('starts every organisation with the standard rules, one set of them', async () => {
    const res = await http.get('/api/orgs/rules-itpo/rules').set(auth(owner)).expect(200);
    expect(res.body).toMatchObject({
      drawingProfile: 'free',
      values: { passageWidth: { B2B: 3, B2C: 3 }, peripheralClearance: 1 },
    });
    expect(res.body.switches.stallOverlap).toBe(true);
    // The old rule-set routes are gone.
    await http.get('/api/orgs/rules-itpo/rules/sets').set(auth(owner)).expect(404);
  });

  it('refuses values outside their limits, unknown rules and unknown profiles', async () => {
    const current = await http.get('/api/orgs/rules-itpo/rules').set(auth(owner)).expect(200);
    const tooNarrow = await http
      .patch('/api/orgs/rules-itpo/rules')
      .set(auth(owner))
      .send({ values: { ...current.body.values, passageWidth: { B2B: 1, B2C: 3 } } })
      .expect(400);
    expect(tooNarrow.body.message).toMatch(/1\.5–5 m/);
    await http
      .patch('/api/orgs/rules-itpo/rules')
      .set(auth(owner))
      .send({ switches: { flyingStalls: false } })
      .expect(400);
    await http
      .patch('/api/orgs/rules-itpo/rules')
      .set(auth(owner))
      .send({ drawingProfile: 'autocad' })
      .expect(400);
  });

  it('switches rules, sets the profile and documents, recorded in the audit log', async () => {
    const res = await http
      .patch('/api/orgs/rules-itpo/rules')
      .set(auth(owner))
      .send({
        switches: { cornerKeepOut: false },
        drawingProfile: 'grid',
        references: [{ document: 'Public Safety Measures and Design Guidelines', section: 'D' }],
      })
      .expect(200);
    expect(res.body).toMatchObject({
      drawingProfile: 'grid',
      references: [{ document: 'Public Safety Measures and Design Guidelines', section: 'D' }],
    });
    expect(res.body.switches.cornerKeepOut).toBe(false);
    const audit = await http.get('/api/orgs/rules-itpo/audit').set(auth(owner)).expect(200);
    const entry = audit.body.items.find((e: { action: string }) => e.action === 'rules.updated');
    expect(entry.metadata.changed).toEqual([
      'switches (cornerKeepOut)',
      'references',
      'drawing profile',
    ]);
    // Read only for those who only see rules.
    const seen = await http.get('/api/orgs/rules-itpo/rules').set(auth(viewer)).expect(200);
    expect(seen.body.switches.cornerKeepOut).toBe(false);
  });

  it("checks stalls on a hall against the organisation's rules, with the drawing profile", async () => {
    const res = await http
      .post('/api/orgs/rules-itpo/rules/check')
      .set(auth(viewer))
      .send({
        hallId,
        eventType: 'B2B',
        stalls: [
          { id: 'a', number: 'A1', x: 10, y: 10, width: 3, depth: 3, openSides: ['bottom'] },
          { id: 'b', number: 'A2', x: 12, y: 10, width: 3, depth: 3, openSides: ['bottom'] },
          { id: 'c', number: 'A3', x: 20.5, y: 10, width: 3, depth: 3, openSides: ['bottom'] },
        ],
      })
      .expect(200);
    expect(res.body.hall).toMatchObject({ name: 'Hall R', version: 1 });
    expect(res.body.passed).toBe(false);
    const found = res.body.violations.map((v: { ruleId: string }) => v.ruleId).sort();
    expect(found).toEqual(['profile.grid', 'stallOverlap']);
  });

  it('sets violations aside with a reason, and asks for the reason', async () => {
    const stalls = [
      { id: 'a', x: 10, y: 10, width: 3, depth: 3, openSides: ['bottom'] },
      { id: 'b', x: 12, y: 10, width: 3, depth: 3, openSides: ['bottom'] },
    ];
    const res = await http
      .post('/api/orgs/rules-itpo/rules/check')
      .set(auth(owner))
      .send({
        hallId,
        eventType: 'B2B',
        stalls,
        overrides: [
          { ruleId: 'stallOverlap', stallIds: ['a', 'b'], reason: 'One exhibitor, joint stand' },
        ],
      })
      .expect(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.violations[0].overridden).toMatchObject({
      reason: 'One exhibitor, joint stand',
    });
    await http
      .post('/api/orgs/rules-itpo/rules/check')
      .set(auth(owner))
      .send({
        hallId,
        eventType: 'B2B',
        stalls,
        overrides: [{ ruleId: 'stallOverlap', reason: '' }],
      })
      .expect(400);
  });

  it('keeps rules to their organisation and their permissions', async () => {
    await http.get('/api/orgs/rules-itpo/rules').set(auth(outsider)).expect(403);
    await http
      .post('/api/orgs/rules-jio/rules/check')
      .set(auth(outsider))
      .send({ hallId, eventType: 'B2B', stalls: [] })
      .expect(404);
    await http
      .patch('/api/orgs/rules-itpo/rules')
      .set(auth(viewer))
      .send({ switches: { stallOverlap: false } })
      .expect(403);
  });
});
