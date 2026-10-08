import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';
describe('Venue CSV import', () => {
  let app: INestApplication,
    http: ReturnType<typeof request>,
    token: string,
    venue: string,
    venue2: string;
  let preview: any, saved: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/orgs/csv-venue/venues/${venue}/halls/import/csv`;
  const file = { content: readFileSync(join(__dirname, 'fixtures/csv/hall-layouts.csv'), 'utf8') };
  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const org = await http
      .post('/api/admin/organisations')
      .set({ Authorization: `Bearer ${root}` })
      .send({
        name: 'CSV venue',
        slug: 'csv-venue',
        limits: { venues: 2, users: 25, storageMb: 1024 },
        firstAdmin: { email: 'csv@venue.test' },
      })
      .expect(201);
    token = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(org.body.invitation.inviteUrl)}/accept`)
        .send({ name: 'CSV owner', password: 'csv-import-password-123' })
        .expect(200)
    ).body.accessToken;
    venue = (
      await http
        .post('/api/orgs/csv-venue/venues')
        .set(auth())
        .send({ name: 'Main venue' })
        .expect(201)
    ).body.id;
    venue2 = (
      await http
        .post('/api/orgs/csv-venue/venues')
        .set(auth())
        .send({ name: 'Other venue' })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
  });
  it('previews all sample CSV halls without creating records', async () => {
    preview = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(preview.rows).toHaveLength(29);
    expect(preview.rows.every((r: any) => r.floor && !r.error)).toBe(true);
    expect(preview.rows[0]).toMatchObject({
      externalId: '56',
      name: 'Hall 56',
      width: 65,
      depth: 90,
      source: 'csv',
    });
    expect(
      (await http.get(`/api/orgs/csv-venue/venues/${venue}/halls`).set(auth()).expect(200)).body,
    ).toHaveLength(0);
  });
  it('requires a current reviewed preview and validates selected source rows', async () => {
    const body = {
      ...file,
      halls: [{ externalId: '56', name: 'First floor' }],
      previewToken: preview.previewToken,
      reviewed: false,
    };
    await http.post(base()).set(auth()).send(body).expect(400);
    await http
      .post(base())
      .set(auth())
      .send({ ...body, reviewed: true, previewToken: 'a'.repeat(64) })
      .expect(409);
    await http
      .post(base())
      .set(auth())
      .send({ ...body, reviewed: true, halls: [{ externalId: 'missing', name: 'Missing' }] })
      .expect(400);
  });
  it('saves two selected sample halls separately in floor/1 with CSV provenance and metadata', async () => {
    const result = (
      await http
        .post(base())
        .set(auth())
        .send({
          ...file,
          halls: [
            { externalId: '56', name: 'First floor north' },
            { externalId: '54', name: 'First floor south' },
          ],
          previewToken: preview.previewToken,
          reviewed: true,
        })
        .expect(201)
    ).body;
    expect(result.created).toHaveLength(2);
    saved = result.created[0].id;
    const detail = (await http.get(`/api/orgs/csv-venue/halls/${saved}`).set(auth()).expect(200))
      .body;
    expect(detail.floor.schema).toBe('floor/1');
    expect(detail.floor.labels).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'FOYER 4F' })]),
    );
    expect(detail.floor.iconGroups.length).toBeGreaterThan(0);
    expect(detail.floor.legend).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'GF:' })]),
    );
    expect(detail.versions[0].source).toBe('csv');
    expect(detail.source.system).toBe('csv');
  });
  it('reimports unchanged sample data without duplicates and scopes IDs to each venue', async () => {
    const next = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(next.rows[0].existing).toMatchObject({ hallId: saved, sameFloor: true });
    const result = (
      await http
        .post(base())
        .set(auth())
        .send({
          ...file,
          halls: [{ externalId: '56', name: 'Ignore' }],
          previewToken: next.previewToken,
          reviewed: true,
        })
        .expect(201)
    ).body;
    expect(result.created).toHaveLength(0);
    expect(result.unchanged[0].id).toBe(saved);
    const other = (
      await http
        .post(`/api/orgs/csv-venue/venues/${venue2}/halls/import/csv/preview`)
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(other.rows[0].existing).toBeNull();
  });
  it('saves all 29 sample halls in one batch and reads back their complete converted floors', async () => {
    const url = `/api/orgs/csv-venue/venues/${venue2}/halls/import/csv`;
    const p = (
      await http
        .post(url + '/preview')
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    const body = {
      ...file,
      halls: p.rows.map((r: any) => ({ externalId: r.externalId, name: r.name })),
      previewToken: p.previewToken,
      reviewed: true,
    };
    const imported = (await http.post(url).set(auth()).send(body).expect(201)).body;
    expect(imported.created).toHaveLength(29);
    expect(imported.updated).toHaveLength(0);
    expect(imported.unchanged).toHaveLength(0);
    const savedHalls = (
      await http.get(`/api/orgs/csv-venue/venues/${venue2}/halls`).set(auth()).expect(200)
    ).body;
    expect(savedHalls).toHaveLength(29);
    for (const row of p.rows) {
      const savedHall = imported.created.find((h: any) => h.name === row.name);
      expect(savedHall).toBeDefined();
      const detail = (
        await http.get(`/api/orgs/csv-venue/halls/${savedHall.id}`).set(auth()).expect(200)
      ).body;
      expect(detail.floor).toEqual(row.floor);
    }
  });
  it('adapts generic venue columns with foyers and isolates malformed rows', async () => {
    const generic = {
      content:
        'id,name,width,depth,unit,foyers\r\nother,Other venue,20,30,m,"[{""name"":""Entry"",""x"":0,""y"":30,""width"":5,""height"":3}]"\r\nbad,Bad,20,30,m,[broken\r\n',
    };
    const p = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(generic)
        .expect(200)
    ).body;
    expect(p.rows[0]).toMatchObject({ error: null, width: 20, depth: 33 });
    expect(p.rows[0].floor.geometry.zones[0]).toMatchObject({ name: 'Entry', kind: 'foyer' });
    expect(p.rows[1].error).toMatch(/invalid JSON/);
    await http
      .post(base())
      .set(auth())
      .send({
        ...generic,
        halls: [{ externalId: p.rows[1].externalId, name: 'Bad' }],
        previewToken: p.previewToken,
        reviewed: true,
      })
      .expect(400);
    const created = (
      await http
        .post(base())
        .set(auth())
        .send({
          ...generic,
          halls: [{ externalId: p.rows[0].externalId, name: 'Other venue' }],
          previewToken: p.previewToken,
          reviewed: true,
        })
        .expect(201)
    ).body;
    expect(created.created).toHaveLength(1);
  });
  it('enforces authentication, mapping validation and CSV structure', async () => {
    await http
      .post(base() + '/preview')
      .send(file)
      .expect(401);
    await http
      .post(base() + '/preview')
      .set(auth())
      .send({ ...file, mapping: { execute: 'arbitrary' } })
      .expect(400);
    await http
      .post(base() + '/preview')
      .set(auth())
      .send({ content: 'id,width,depth\na,20' })
      .expect(400);
    await http
      .post(base() + '/preview')
      .set(auth())
      .send({ content: JSON.stringify({ width: 20, depth: 30, unit: 'm' }) })
      .expect(400);
  });
});
