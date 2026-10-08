import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';
describe('Generic venue JSON import', () => {
  let app: INestApplication,
    http: ReturnType<typeof request>,
    token: string,
    venue: string,
    venue2: string,
    hall: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/orgs/json-venue/venues/${venue}/halls/import/json`;
  const file = {
    content: JSON.stringify({
      halls: [
        {
          id: 'a',
          name: 'JSON North',
          unit: 'mm',
          width: 20000,
          depth: 30000,
          foyers: [{ name: 'Entry', x: 0, y: 30000, width: 5000, height: 3000 }],
          columns: [{ x: 5000, y: 5000, width: 1000, height: 1000 }],
        },
        { id: 'broken', name: 'Bad', width: 100, height: 100 },
      ],
    }),
    mapping: {},
  };
  let preview: any;
  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const org = await http
      .post('/api/admin/organisations')
      .set({ Authorization: `Bearer ${root}` })
      .send({
        name: 'Generic JSON venue',
        slug: 'json-venue',
        limits: { venues: 2, users: 25, storageMb: 1024 },
        firstAdmin: { email: 'json@venue.test' },
      })
      .expect(201);
    token = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(org.body.invitation.inviteUrl)}/accept`)
        .send({ name: 'Venue owner', password: 'json-import-password-123' })
        .expect(200)
    ).body.accessToken;
    venue = (
      await http
        .post('/api/orgs/json-venue/venues')
        .set(auth())
        .send({ name: 'Generic venue' })
        .expect(201)
    ).body.id;
    venue2 = (
      await http
        .post('/api/orgs/json-venue/venues')
        .set(auth())
        .send({ name: 'Another venue' })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
  });
  it('previews each hall independently and reports unreadable rows without saving', async () => {
    preview = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(preview.rows[0]).toMatchObject({
      name: 'JSON North',
      width: 20,
      depth: 33,
      error: null,
    });
    expect(preview.rows[0].floor.geometry.zones).toHaveLength(1);
    expect(preview.rows[1].error).toMatch(/source units/);
    expect(
      (await http.get(`/api/orgs/json-venue/venues/${venue}/halls`).set(auth()).expect(200)).body,
    ).toHaveLength(0);
  });
  it('requires a current preview and explicit inspection; malformed selected rows cannot be saved', async () => {
    const choice = { externalId: preview.rows[0].externalId, name: 'JSON North' };
    await http
      .post(base())
      .set(auth())
      .send({ ...file, halls: [choice], previewToken: preview.previewToken, reviewed: false })
      .expect(400);
    await http
      .post(base())
      .set(auth())
      .send({
        ...file,
        mapping: { unit: 'ft' },
        halls: [choice],
        previewToken: preview.previewToken,
        reviewed: true,
      })
      .expect(409);
    await http
      .post(base())
      .set(auth())
      .send({
        ...file,
        halls: [{ externalId: preview.rows[1].externalId, name: 'Bad' }],
        previewToken: preview.previewToken,
        reviewed: true,
      })
      .expect(400);
  });
  it('saves the chosen hall in our canonical JSON with its foyer and provenance', async () => {
    const result = await http
      .post(base())
      .set(auth())
      .send({
        ...file,
        halls: [{ externalId: preview.rows[0].externalId, name: 'JSON North' }],
        previewToken: preview.previewToken,
        reviewed: true,
      })
      .expect(201);
    hall = result.body.created[0].id;
    const detail = (await http.get(`/api/orgs/json-venue/halls/${hall}`).set(auth()).expect(200))
      .body;
    expect(detail.floor.schema).toBe('floor/1');
    expect(detail.floor.geometry.unit).toBe('m');
    expect(detail.floor.geometry.objects[0].kind).toBe('column');
    expect(detail.versions[0].source).toBe('json');
    expect(detail.source.system).toBe('json');
  });
  it('reimports unchanged data without duplicates and scopes source identities by venue', async () => {
    const next = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(next.rows[0].existing).toMatchObject({ hallId: hall, sameFloor: true });
    const result = await http
      .post(base())
      .set(auth())
      .send({
        ...file,
        halls: [{ externalId: next.rows[0].externalId, name: 'Ignored' }],
        previewToken: next.previewToken,
        reviewed: true,
      })
      .expect(201);
    expect(result.body.created).toHaveLength(0);
    expect(result.body.unchanged[0].id).toBe(hall);
    const other = (
      await http
        .post(`/api/orgs/json-venue/venues/${venue2}/halls/import/json/preview`)
        .set(auth())
        .send(file)
        .expect(200)
    ).body;
    expect(other.rows[0].existing).toBeNull();
  });
  it('rejects stale previews after a hall version changes and then creates a new version', async () => {
    const changed = JSON.parse(file.content);
    changed.halls[0].width = 21000;
    const update = { content: JSON.stringify(changed), mapping: {} };
    const p = (
      await http
        .post(base() + '/preview')
        .set(auth())
        .send(update)
        .expect(200)
    ).body;
    const body = {
      ...update,
      halls: [{ externalId: p.rows[0].externalId, name: 'JSON North' }],
      previewToken: p.previewToken,
      reviewed: true,
    };
    const result = await http.post(base()).set(auth()).send(body).expect(201);
    expect(result.body.updated[0]).toMatchObject({ id: hall, currentVersion: 2 });
    await http.post(base()).set(auth()).send(body).expect(409);
  });
  it('enforces authentication, scope and strict mapping validation', async () => {
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
      .send({ content: 'broken' })
      .expect(400);
    await http
      .post('/api/orgs/no-such-org/venues/' + venue + '/halls/import/json/preview')
      .set(auth())
      .send(file)
      .expect(404);
  });
});
