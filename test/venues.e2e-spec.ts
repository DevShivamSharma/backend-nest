import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/itpo', name), 'utf8');

/**
 * Module B end to end: venues within the organisation's limit, halls with their floor history,
 * and ITPO's hall floors brought in from an export, imported again without duplicates.
 */
describe('Venues and halls (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let owner: string;
  let viewer: string;
  let outsider: string;
  let organisationId: string;
  let venueId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function organisation(slug: string, email: string, limits?: object) {
    const res = await http
      .post('/api/admin/organisations')
      .set(auth(root))
      .send({ name: `Org ${slug}`, slug, firstAdmin: { email }, ...(limits ? { limits } : {}) })
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

    const itpo = await organisation('itpo', 'ops@itpo.test', {
      venues: 2,
      users: 25,
      storageMb: 1024,
    });
    organisationId = itpo.id;
    owner = itpo.token;
    outsider = (await organisation('jio', 'ops@jio.test')).token;

    // A role that may only look at venues.
    const role = await http
      .post('/api/admin/roles')
      .set(auth(root))
      .send({
        organisationId,
        key: 'hall_viewer',
        name: 'Hall viewer',
        scopeKind: 'organisation',
        permissions: ['venues.view'],
      })
      .expect(201);
    const invited = await http
      .post('/api/orgs/itpo/invitations')
      .set(auth(owner))
      .send({ email: 'viewer@itpo.test', roleId: role.body.id })
      .expect(201);
    viewer = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
        .send({ name: 'Viewer', password: 'viewer-password-1' })
        .expect(200)
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('venues', () => {
    it('creates a venue and keeps names unique', async () => {
      const res = await http
        .post('/api/orgs/itpo/venues')
        .set(auth(owner))
        .send({ name: 'Bharat Mandapam', code: 'BM', address: 'Pragati Maidan, New Delhi' })
        .expect(201);
      venueId = res.body.id;
      expect(res.body).toMatchObject({ name: 'Bharat Mandapam', code: 'BM', hallCount: 0 });

      await http
        .post('/api/orgs/itpo/venues')
        .set(auth(owner))
        .send({ name: 'bharat mandapam' })
        .expect(409);
    });

    it('stops at the organisation’s venue limit', async () => {
      await http.post('/api/orgs/itpo/venues').set(auth(owner)).send({ name: 'Annex' }).expect(201);
      const refused = await http
        .post('/api/orgs/itpo/venues')
        .set(auth(owner))
        .send({ name: 'Third' })
        .expect(409);
      expect(refused.body.message).toMatch(/2 venue/);
    });

    it('lets a viewer look but not change anything', async () => {
      const list = await http.get('/api/orgs/itpo/venues').set(auth(viewer)).expect(200);
      expect(list.body.map((v: { name: string }) => v.name)).toEqual(['Annex', 'Bharat Mandapam']);
      await http
        .patch(`/api/orgs/itpo/venues/${venueId}`)
        .set(auth(viewer))
        .send({ name: 'Renamed' })
        .expect(403);
    });

    it('keeps other organisations out', async () => {
      await http.get('/api/orgs/itpo/venues').set(auth(outsider)).expect(403);
      await http.get(`/api/orgs/jio/venues/${venueId}`).set(auth(outsider)).expect(404);
    });

    it('deletes only an empty venue', async () => {
      const annex = (await http.get('/api/orgs/itpo/venues').set(auth(owner))).body.find(
        (v: { name: string }) => v.name === 'Annex',
      );
      await http.delete(`/api/orgs/itpo/venues/${annex.id}`).set(auth(owner)).expect(204);
    });
  });

  describe('halls', () => {
    let hallId: string;

    it('creates a hall as an empty floor, version 1', async () => {
      const created = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls`)
        .set(auth(owner))
        .send({ name: 'Hall 5', level: 'Ground', width: 60, depth: 40, uses: { fnb: true } })
        .expect(201);
      hallId = created.body.id;
      expect(created.body).toMatchObject({
        width: 60,
        depth: 40,
        floorArea: 2400,
        currentVersion: 1,
        uses: { fnb: true },
        source: null,
      });

      const detail = await http.get(`/api/orgs/itpo/halls/${hallId}`).set(auth(viewer)).expect(200);
      expect(detail.body.floor).toMatchObject({ schema: 'floor/1', width: 60, areas: [] });
      expect(detail.body.versions).toEqual([
        expect.objectContaining({ version: 1, source: 'blank', current: true }),
      ]);
    });

    it('validates sizes and names', async () => {
      await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls`)
        .set(auth(owner))
        .send({ name: 'Too big', width: 5000, depth: 10 })
        .expect(400);
      await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls`)
        .set(auth(owner))
        .send({ name: 'HALL 5', width: 10, depth: 10 })
        .expect(409);
    });

    it('edits the hall’s details without touching its floor', async () => {
      const res = await http
        .patch(`/api/orgs/itpo/halls/${hallId}`)
        .set(auth(owner))
        .send({ code: 'H5', uses: { branding: true } })
        .expect(200);
      expect(res.body).toMatchObject({ code: 'H5', uses: { branding: true }, currentVersion: 1 });
    });

    it('deletes a hall', async () => {
      await http.delete(`/api/orgs/itpo/halls/${hallId}`).set(auth(viewer)).expect(403);
      await http.delete(`/api/orgs/itpo/halls/${hallId}`).set(auth(owner)).expect(204);
      await http.get(`/api/orgs/itpo/halls/${hallId}`).set(auth(owner)).expect(404);
    });

    it('stores positioned manual helpers and legends, and versions later annotation edits without resizing', async () => {
      const annotations = {
        labels: [{ text: 'Gate A', x: 3, y: 42, width: 10, height: 1 }],
        iconGroups: [
          {
            x: 12,
            y: -5,
            width: 8,
            height: 4,
            icons: [
              { kind: 'toilet-male', label: 'Male toilet' },
              { kind: 'lift', label: 'Lift' },
            ],
          },
        ],
        legend: [{ label: 'Facilities', color: '#53849d', showInView: true }],
      };
      const url = `/api/orgs/itpo/venues/${venueId}/halls`;
      const created = await http
        .post(url)
        .set(auth(owner))
        .send({ name: 'Manual helpers', width: 60, depth: 40, annotations })
        .expect(201);
      const id = created.body.id;
      const detailUrl = `/api/orgs/itpo/halls/${id}`;
      const detail = (await http.get(detailUrl).set(auth(owner)).expect(200)).body;
      expect(detail.floor).toMatchObject({ ...annotations, width: 60, depth: 40, areas: [] });
      expect(detail.floorArea).toBe(2400);
      expect(detail.floor.geometry.source.documentId).toBe('manual');
      const moved = {
        ...annotations,
        iconGroups: annotations.iconGroups.map((g) => ({ ...g, x: 63, y: 8 })),
      };
      await http
        .patch(detailUrl)
        .set(auth(viewer))
        .send({ annotations: moved, expectedVersion: 1 })
        .expect(403);
      await http
        .patch(detailUrl)
        .set(auth(owner))
        .send({ annotations: moved, expectedVersion: 1 })
        .expect(200);
      const edited = (await http.get(detailUrl).set(auth(owner)).expect(200)).body;
      expect(edited.currentVersion).toBe(2);
      expect(edited.floor).toMatchObject(moved);
      expect(edited.floor.geometry).toEqual(detail.floor.geometry);
      expect([edited.width, edited.depth, edited.floorArea]).toEqual([60, 40, 2400]);
      expect(edited.versions).toHaveLength(2);
      const old = (
        await http
          .get(detailUrl + '/versions/1')
          .set(auth(owner))
          .expect(200)
      ).body;
      expect(old.floor).toEqual(detail.floor);
      await http
        .patch(detailUrl)
        .set(auth(owner))
        .send({ annotations, expectedVersion: 1 })
        .expect(409);
      await http
        .patch(detailUrl)
        .set(auth(owner))
        .send({ annotations: moved, expectedVersion: 2 })
        .expect(200);
      expect((await http.get(detailUrl).set(auth(owner)).expect(200)).body.currentVersion).toBe(2);
      for (const bad of [
        { ...annotations, labels: [{ text: 'Bad', x: 'invalid', y: 0 }] },
        {
          ...annotations,
          iconGroups: [{ x: 0, y: 0, icons: [{ kind: 'unknown', label: 'Bad' }] }],
        },
        { ...annotations, legend: [{ label: 'Bad', color: 'url(unsafe)', showInView: true }] },
        { ...annotations, geometry: {} },
      ]) {
        await http
          .post(url)
          .set(auth(owner))
          .send({
            name: 'Invalid helpers',
            width: 20,
            depth: 30,
            annotations: bad,
          })
          .expect(400);
      }
      await http.delete(detailUrl).set(auth(owner)).expect(204);
    });
    it('deletes several halls at once, all or none', async () => {
      const make = async (name: string) =>
        (
          await http
            .post(`/api/orgs/itpo/venues/${venueId}/halls`)
            .set(auth(owner))
            .send({ name, width: 20, depth: 10 })
            .expect(201)
        ).body.id as string;
      const ids = [await make('Bulk 1'), await make('Bulk 2')];
      const url = `/api/orgs/itpo/venues/${venueId}/halls/delete`;

      await http.post(url).set(auth(viewer)).send({ hallIds: ids }).expect(403);
      await http.post(url).set(auth(owner)).send({ hallIds: [] }).expect(400);
      await http
        .post(url)
        .set(auth(owner))
        .send({ hallIds: [...ids, '7d3f9a52-1b8e-4c2a-9f0e-2a1b3c4d5e6f'] })
        .expect(404);
      await http.get(`/api/orgs/itpo/halls/${ids[0]}`).set(auth(owner)).expect(200);

      const res = await http.post(url).set(auth(owner)).send({ hallIds: ids }).expect(200);
      expect(res.body).toEqual({ deleted: 2 });
      for (const id of ids) {
        await http.get(`/api/orgs/itpo/halls/${id}`).set(auth(owner)).expect(404);
      }
    });
  });

  describe('ITPO import', () => {
    const file = { format: 'json' as const, content: fixture('hall-14ff.json') };
    let hallId: string;

    it('previews without saving anything', async () => {
      const res = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo/preview`)
        .set(auth(owner))
        .send(file)
        .expect(200);
      expect(res.body.rows).toEqual([
        expect.objectContaining({
          externalId: '62',
          name: 'Hall 14FF',
          width: 84,
          depth: 116,
          counts: expect.objectContaining({ wall: 126, outside: 67, fire_curtain: 3 }),
          existing: null,
          error: null,
        }),
      ]);
      const halls = await http.get(`/api/orgs/itpo/venues/${venueId}/halls`).set(auth(owner));
      expect(halls.body).toEqual([]);
    });

    it('needs the import permission', async () => {
      await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo/preview`)
        .set(auth(viewer))
        .send(file)
        .expect(403);
    });

    it('imports a hall with the name given, linked to ITPO’s hall id', async () => {
      const res = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo`)
        .set(auth(owner))
        .send({
          ...file,
          halls: [{ externalId: '62', name: 'Hall 14 First Floor', level: 'First' }],
        })
        .expect(201);
      expect(res.body.created).toEqual([
        expect.objectContaining({
          name: 'Hall 14 First Floor',
          level: 'First',
          source: { system: 'itpo', externalId: '62' },
          currentVersion: 1,
        }),
      ]);
      hallId = res.body.created[0].id;

      const detail = await http.get(`/api/orgs/itpo/halls/${hallId}`).set(auth(owner)).expect(200);
      expect(detail.body.floor.areas).toHaveLength(203);
      expect(detail.body.versions[0]).toMatchObject({
        source: 'itpo',
        sourceRef: 'ITPO hall 62',
      });
    });

    it('imports the same file again as "unchanged", never as a second hall', async () => {
      const preview = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo/preview`)
        .set(auth(owner))
        .send(file)
        .expect(200);
      expect(preview.body.rows[0].existing).toMatchObject({ hallId, sameFloor: true });

      const res = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo`)
        .set(auth(owner))
        .send({ ...file, halls: [{ externalId: '62', name: 'Ignored' }] })
        .expect(201);
      expect(res.body).toMatchObject({ created: [], updated: [], unchanged: [{ id: hallId }] });
    });

    it('adds a floor version when ITPO’s floor changed, and restores the old one forward', async () => {
      const changed = JSON.parse(file.content);
      changed.data[0].layout_data.nonClickableAreas.push({
        x: 40,
        y: 40,
        width: 2,
        height: 2,
        fillColor: 'red',
      });
      const res = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo`)
        .set(auth(owner))
        .send({
          format: 'json',
          content: JSON.stringify(changed),
          halls: [{ externalId: '62', name: 'x' }],
        })
        .expect(201);
      expect(res.body.updated).toEqual([
        expect.objectContaining({ id: hallId, name: 'Hall 14 First Floor', currentVersion: 2 }),
      ]);

      const v1 = await http
        .get(`/api/orgs/itpo/halls/${hallId}/versions/1`)
        .set(auth(viewer))
        .expect(200);
      expect(v1.body.floor.areas).toHaveLength(203);

      const restored = await http
        .post(`/api/orgs/itpo/halls/${hallId}/versions/1/restore`)
        .set(auth(owner))
        .expect(200);
      expect(restored.body.currentVersion).toBe(3);
      expect(restored.body.floor.areas).toHaveLength(203);
      expect(restored.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
      expect(restored.body.versions[0]).toMatchObject({ source: 'restore', current: true });
    });

    it('reads a CSV export and reports rows it cannot use', async () => {
      const csv =
        '"id","hall_id","layout_data","length","breadth"\n' +
        '"20","56","{""nonClickableAreas"": []}","65.0","90.0"\n' +
        '"21","57","NULL","NULL","NULL"\n';
      const res = await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo/preview`)
        .set(auth(owner))
        .send({ format: 'csv', content: csv })
        .expect(200);
      expect(res.body.rows).toEqual([
        expect.objectContaining({
          externalId: '56',
          name: 'ITPO hall 56',
          floorArea: 5850,
          error: null,
        }),
        expect.objectContaining({
          externalId: '57',
          error: expect.stringMatching(/length and breadth/),
        }),
      ]);

      await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo`)
        .set(auth(owner))
        .send({ format: 'csv', content: csv, halls: [{ externalId: '57', name: 'Broken' }] })
        .expect(400);
      await http
        .post(`/api/orgs/itpo/venues/${venueId}/halls/import/itpo`)
        .set(auth(owner))
        .send({ format: 'csv', content: 'not,a,layout\n1,2,3\n' })
        .expect(400);
    });

    it('records the imports in the audit log', async () => {
      const res = await http.get('/api/orgs/itpo/audit?pageSize=50').set(auth(owner)).expect(200);
      const actions = res.body.items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'venue.created',
          'hall.created',
          'hall.imported',
          'hall.floor_reimported',
          'hall.floor_restored',
        ]),
      );
    });
  });
});
