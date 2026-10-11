import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { samplePlan } from './fixtures/pdf/cad-pdf';
import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

/**
 * A hall's CAD plan PDF read for its stall plan: the stalls per hall of the drawing for review,
 * and the drawing as DXF, only for those who may draw the plan. Nothing is saved.
 */
describe('Stall import from a CAD plan (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let owner: string;
  let hall: string;
  let fair: string;
  let expo: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = '/api/orgs/di-itpo';
  const drawing = (event: string) => `${base}/events/${event}/halls/${hall}/plan/drawing`;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const org = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: 'Org di', slug: 'di-itpo', firstAdmin: { email: 'ops@di-itpo.test' } })
      .expect(201);
    owner = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(org.body.invitation.inviteUrl)}/accept`)
        .send({ name: 'Ops', password: 'owner-password-1' })
        .expect(200)
    ).body.accessToken;
    const venue = await http.post(`${base}/venues`).set(auth(owner)).send({ name: 'Pragati' });
    hall = (
      await http
        .post(`${base}/venues/${venue.body.id}/halls`)
        .set(auth(owner))
        .send({ name: 'Hall 8', width: 40, depth: 30 })
        .expect(201)
    ).body.id;
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
        .send({ hallIds: [hall] })
        .expect(201);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('reads the stalls of a CAD plan per hall of the drawing, the L-shape as one outline', async () => {
    const res = await http
      .post(drawing(fair))
      .set(auth(owner))
      .attach('file', samplePlan(), { filename: 'plan.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(res.body.usedLayers).toBe(true);
    expect(res.body.groups).toEqual([
      expect.objectContaining({ group: '8', pitchX: expect.closeTo(10, 3) }),
    ]);
    const byName = Object.fromEntries(res.body.stalls.map((s: { name: string }) => [s.name, s]));
    expect(byName['08-01 C']).toEqual(expect.objectContaining({ shape: 'L-shape', area: 30 }));
    expect(byName['08-01 D']).toEqual(expect.objectContaining({ shape: 'rectangle', area: 12 }));
    expect(res.body.hall).toEqual({ groups: ['8'], drawingHalls: ['8'], matchedByName: true });
  });

  it('gives the drawing as DXF, its layers kept, in metres', async () => {
    const res = await http
      .post(`${drawing(fair)}/dxf`)
      .set(auth(owner))
      .attach('file', samplePlan(), { filename: 'plan.pdf', contentType: 'application/pdf' })
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => done(null, text));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('application/dxf');
    const dxf = res.body as string;
    expect(dxf).toMatch(/^0\nSECTION\n2\nHEADER/);
    for (const layer of ['PARTITION', 'FACIA', 'GRID'])
      expect(dxf).toContain(`\nLAYER\n2\n${layer}\n`);
    expect(dxf).toContain('\nLINE\n');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('refuses what is not a PDF, a bad page, the plan of another hall, and a plan the member may not draw', async () => {
    await http.post(drawing(fair)).set(auth(owner)).expect(400);
    await http
      .post(drawing(fair))
      .set(auth(owner))
      .attach('file', Buffer.from('hello'), { filename: 'plan.pdf' })
      .expect(400);
    await http
      .post(`${drawing(fair)}?page=0`)
      .set(auth(owner))
      .attach('file', samplePlan(), { filename: 'plan.pdf' })
      .expect(400);
    // Hall 8's plan for Hall 5: the wrong plan, said so.
    const venueId = (await http.get(`${base}/venues`).set(auth(owner))).body[0].id;
    const hall5 = (
      await http
        .post(`${base}/venues/${venueId}/halls`)
        .set(auth(owner))
        .send({ name: 'Hall 5', width: 40, depth: 30 })
        .expect(201)
    ).body.id;
    await http
      .post(`${base}/events/${fair}/halls`)
      .set(auth(owner))
      .send({ hallIds: [hall5] });
    const wrong = await http
      .post(`${base}/events/${fair}/halls/${hall5}/plan/drawing`)
      .set(auth(owner))
      .attach('file', samplePlan(), { filename: 'plan.pdf' })
      .expect(422);
    expect(wrong.body.message).toContain('Wrong plan: this drawing is of Hall 8, not Hall 5.');
    // An external event's plan is drawn by its organiser's team, not the venue's.
    await http
      .post(drawing(expo))
      .set(auth(owner))
      .attach('file', samplePlan(), { filename: 'plan.pdf' })
      .expect(403);
  });
});
