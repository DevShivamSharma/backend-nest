import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, login, SUPER_ADMIN, tokenFrom } from './test-app';
import { FloorPlanImportEntity } from '../src/venues/floor-plan/plan-import.entity';
import { PLAN_READER_VERSION } from '../src/venues/floor-plan/floor-plan.service';
import { HallEntity } from '../src/venues/hall.entity';
import { area, intersection, rectangle } from '../src/venues/floor-plan/geometry';
import type { PlanPage } from '../src/venues/floor-plan/plan.types';
describe('Floor-plan import persistence and guards', () => {
  let app: INestApplication,
    http: ReturnType<typeof request>,
    token: string,
    org: string,
    venue: string,
    docId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/orgs/sample/venues/${venue}/floor-plans/${docId}`;
  const source = Buffer.from('Cached, manually reviewed drawing');
  const page: PlanPage = {
    number: 1,
    width: 100,
    height: 100,
    format: 'dxf',
    preview: '',
    texts: [],
    regions: [
      {
        id: 'alpha',
        name: 'Alpha',
        role: 'hall',
        geometry: rectangle(0, 0, 20, 30),
        hallIds: [],
        confirmed: true,
        restrictionsConfirmed: true,
        grid: { x: 0, y: 0, width: 2, height: 2, rotation: 0 },
        printedArea: 600,
      },
      {
        id: 'beta',
        name: 'Beta',
        role: 'hall',
        geometry: rectangle(30, 0, 20, 30),
        hallIds: [],
        confirmed: false,
        restrictionsConfirmed: true,
        grid: { x: 30, y: 0, width: 2, height: 2, rotation: 0 },
        printedArea: 600,
      },
    ],
    objects: [],
    calibration: { metresPerUnit: 1, source: 'Drawing metre units', confirmed: true },
    grid: null,
    dimensions: [
      {
        id: 'dim-a',
        label: '20 m width',
        a: [0, 0],
        b: [20, 0],
        metres: 20,
        regionId: 'alpha',
        confirmed: true,
      },
      {
        id: 'dim-b',
        label: '20 m width',
        a: [30, 0],
        b: [50, 0],
        metres: 20,
        regionId: 'beta',
        confirmed: true,
      },
    ],
    legend: [],
    warnings: [],
  };
  const selection = (key: string) => ({
    key: `1:${key}`,
    name: key,
    targetHallId: null,
    expectedVersion: null,
    acknowledgements: [],
  });
  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
    const created = await http
      .post('/api/admin/organisations')
      .set({ Authorization: `Bearer ${root}` })
      .send({
        name: 'Sample venue operator',
        slug: 'sample',
        firstAdmin: { email: 'reviewer@sample.test' },
      })
      .expect(201);
    org = created.body.organisation.id;
    token = (
      await http
        .post(`/api/auth/invitations/${tokenFrom(created.body.invitation.inviteUrl)}/accept`)
        .send({ name: 'Reviewer', password: 'reviewer-password-123' })
        .expect(200)
    ).body.accessToken;
    venue = (
      await http
        .post('/api/orgs/sample/venues')
        .set(auth())
        .send({ name: 'A general venue' })
        .expect(201)
    ).body.id;
    const repo = app.get(DataSource).getRepository(FloorPlanImportEntity);
    docId = (
      await repo.save(
        repo.create({
          organisationId: org,
          venueId: venue,
          fileName: 'reviewed.dxf',
          fileHash: createHash('sha256').update(source).digest('hex'),
          readerVersion: PLAN_READER_VERSION,
          status: 'ready',
          revision: 1,
          error: null,
          pages: [page],
          committed: {},
        }),
      )
    ).id;
  });
  afterAll(async () => {
    await app?.close();
  });
  it('returns independent reviewed halls and refuses another venue scope', async () => {
    const result = await http.get(base()).set(auth()).expect(200);
    expect(result.body.halls.map((h: any) => h.ready)).toEqual([true, false]);
    await http
      .get(base().replace(venue, '00000000-0000-4000-8000-000000000000'))
      .set(auth())
      .expect(404);
  });
  it('rejects malformed geometry and stale review revisions', async () => {
    const { number, ...editable } = page;
    const body = {
      revision: 1,
      page: number,
      regions: editable.regions,
      objects: [],
      grid: null,
      calibration: editable.calibration,
      dimensions: editable.dimensions,
    };
    await http
      .patch(base())
      .set(auth())
      .send({
        ...body,
        regions: [
          {
            ...page.regions[0],
            geometry: [
              [
                [
                  [0, 0],
                  [1, 1],
                ],
              ],
            ],
          },
        ],
      })
      .expect(400);
    await http
      .patch(base())
      .set(auth())
      .send({ ...body, revision: 99 })
      .expect(409);
  });
  it('saves a valid hall while returning an unresolved hall failure, then retries idempotently', async () => {
    const result = await http
      .post(base() + '/commit')
      .set(auth())
      .send({ revision: 1, selections: [selection('alpha'), selection('beta')] })
      .expect(201);
    expect(result.body[0].hallId).toBeTruthy();
    expect(result.body[1].error).toContain('Resolve');
    const retry = await http
      .post(base() + '/commit')
      .set(auth())
      .send({ revision: 1, selections: [selection('alpha')] })
      .expect(201);
    expect(retry.body[0].hallId).toBe(result.body[0].hallId);
    const saved = await http
      .get(`/api/orgs/sample/halls/${result.body[0].hallId}`)
      .set(auth())
      .expect(200);
    expect(saved.body.floor.geometry.boundary).toEqual(rectangle(0, 0, 20, 30));
    expect(saved.body.currentVersion).toBe(1);
  });
  it('allows the remaining hall to be reviewed after partial save, without changing saved geometry', async () => {
    const body = {
      revision: 1,
      page: 1,
      regions: page.regions.map((r) => ({ ...r, confirmed: true })),
      objects: [],
      grid: null,
      calibration: page.calibration,
      dimensions: page.dimensions,
    };
    const result = await http.patch(base()).set(auth()).send(body).expect(200);
    expect(result.body.revision).toBe(2);
    await http
      .patch(base())
      .set(auth())
      .send({ ...body, revision: 2, calibration: { ...page.calibration, metresPerUnit: 2 } })
      .expect(409);
    const saved = await http
      .post(base() + '/commit')
      .set(auth())
      .send({ revision: 2, selections: [selection('beta')] })
      .expect(201);
    expect(saved.body[0].hallId).toBeTruthy();
  });
  it('reopens only the deleted hall on re-upload and keeps the other saved hall', async () => {
    const before = (await http.get(base()).set(auth()).expect(200)).body;
    const deletedId = before.committed['1:alpha'];
    const betaId = before.committed['1:beta'];
    await http.delete(`/api/orgs/sample/halls/${deletedId}`).set(auth()).expect(204);
    const uploaded = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', source, 'reviewed.dxf')
      .expect(201);
    expect(uploaded.body.id).toBe(docId);
    const reopened = (await http.get(base()).set(auth()).expect(200)).body;
    expect(reopened.revision).toBe(before.revision);
    expect(reopened.committed).toEqual({ '1:beta': betaId });
    expect(reopened.halls.map((h: any) => h.savedHallId)).toEqual([null, betaId]);
    expect(reopened.pages).toEqual(before.pages);
    const edited = await http
      .patch(base())
      .set(auth())
      .send({
        revision: reopened.revision,
        page: 1,
        regions: reopened.pages[0].regions.map((r: any) => ({
          ...r,
          name: r.id === 'alpha' ? 'Recreated alpha' : r.name,
        })),
        objects: [],
        grid: null,
        calibration: page.calibration,
        dimensions: page.dimensions,
      })
      .expect(200);
    const saved = await http
      .post(base() + '/commit')
      .set(auth())
      .send({ revision: edited.body.revision, selections: [selection('alpha')] })
      .expect(201);
    expect(saved.body[0].error).toBeUndefined();
    expect(saved.body[0].hallId).toBeTruthy();
    expect(saved.body[0].hallId).not.toBe(deletedId);
    await http.get(`/api/orgs/sample/halls/${deletedId}`).set(auth()).expect(404);
  });
  it('reimports both halls after bulk deletion and subsequent retries remain idempotent', async () => {
    const before = (await http.get(base()).set(auth()).expect(200)).body;
    const deletedIds = Object.values(before.committed);
    await http
      .post(`/api/orgs/sample/venues/${venue}/halls/delete`)
      .set(auth())
      .send({ hallIds: deletedIds })
      .expect(200, { deleted: 2 });
    const uploaded = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', source, 'reviewed.dxf')
      .expect(201);
    expect(uploaded.body.id).toBe(docId);
    const reopened = (await http.get(base()).set(auth()).expect(200)).body;
    expect(reopened.committed).toEqual({});
    expect(reopened.halls.every((h: any) => h.savedHallId === null && h.ready)).toBe(true);
    const body = {
      revision: reopened.revision,
      selections: [selection('alpha'), selection('beta')],
    };
    const saved = (
      await http
        .post(base() + '/commit')
        .set(auth())
        .send(body)
        .expect(201)
    ).body;
    expect(saved.every((s: any) => s.hallId && !s.error)).toBe(true);
    expect(saved.every((s: any) => !deletedIds.includes(s.hallId))).toBe(true);
    const retry = (
      await http
        .post(base() + '/commit')
        .set(auth())
        .send(body)
        .expect(201)
    ).body;
    expect(retry.map((s: any) => s.hallId)).toEqual(saved.map((s: any) => s.hallId));
  });
  it('repairs historical dangling saved IDs on direct save and on opening a review', async () => {
    const before = (await http.get(base()).set(auth()).expect(200)).body;
    const halls = app.get(DataSource).getRepository(HallEntity);
    await halls.delete(before.committed['1:alpha']);
    const saved = await http
      .post(base() + '/commit')
      .set(auth())
      .send({ revision: before.revision, selections: [selection('alpha')] })
      .expect(201);
    expect(saved.body[0].error).toBeUndefined();
    expect(saved.body[0].hallId).toBeTruthy();
    expect(saved.body[0].hallId).not.toBe(before.committed['1:alpha']);
    await halls.delete(before.committed['1:beta']);
    const reopened = (await http.get(base()).set(auth()).expect(200)).body;
    expect(reopened.committed).toEqual({ '1:alpha': saved.body[0].hallId });
    expect(reopened.halls[1].savedHallId).toBeNull();
    const persisted = await app
      .get(DataSource)
      .getRepository(FloorPlanImportEntity)
      .findOneByOrFail({ id: docId });
    expect(persisted.committed).toEqual(reopened.committed);
  });
  it('keeps a gridded foyer as a linked zone when reading the hall-title PDF through the worker', async () => {
    const uploaded = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', join(__dirname, 'fixtures/floor-plan/hall-with-gridded-foyer.pdf'))
      .expect(201);
    let view: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      view = (
        await http
          .get(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}`)
          .set(auth())
          .expect(200)
      ).body;
      if (view.status !== 'reading') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(view.status).toBe('ready');
    expect(view.halls.map((h: any) => h.name)).toEqual(['EXHIBITION HALLS -14']);
    expect(view.pages[0].regions.find((r: any) => r.name === 'FOYER-14G')).toMatchObject({
      role: 'foyer',
      hallIds: [view.halls[0].regionId],
      confirmed: false,
    });
    const result = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}/commit`)
      .set(auth())
      .send({
        revision: view.revision,
        selections: [{ ...selection('unused'), key: view.halls[0].key }],
      })
      .expect(201);
    expect(result.body[0].hallId).toBeUndefined();
    expect(result.body[0].error).toBeTruthy();
    expect(view.pages[0].calibration).toMatchObject({ confirmed: true });
    expect(view.pages[0].calibration.source).toContain('CAD grid layer');
    const reviewed = view.pages[0];
    const edited = await http
      .patch(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}`)
      .set(auth())
      .send({
        revision: view.revision,
        page: reviewed.number,
        regions: reviewed.regions.map((r: any) => ({
          ...r,
          confirmed: true,
          restrictionsConfirmed: true,
        })),
        objects: reviewed.objects.map((o: any) => ({ ...o, confirmed: o.kind !== 'unknown' })),
        grid: reviewed.grid,
        calibration: reviewed.calibration,
        dimensions: reviewed.dimensions,
      })
      .expect(200);
    const hall = edited.body.halls[0];
    expect(hall.checks.filter((c: any) => c.status !== 'pass' && !c.overridable)).toEqual([]);
    const saved = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}/commit`)
      .set(auth())
      .send({
        revision: edited.body.revision,
        selections: [
          {
            ...selection('unused'),
            key: hall.key,
            name: hall.name,
            acknowledgements: hall.checks
              .filter((c: any) => c.status !== 'pass' && c.overridable)
              .map((c: any) => c.id),
          },
        ],
      })
      .expect(201);
    expect(saved.body[0].error).toBeUndefined();
    expect(saved.body[0].hallId).toBeTruthy();
    const persisted = await http
      .get(`/api/orgs/sample/halls/${saved.body[0].hallId}`)
      .set(auth())
      .expect(200);
    expect(persisted.body.floor.geometry.zones).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'FOYER-14G', kind: 'foyer' })]),
    );
    expect(persisted.body.floor.geometry.grid.width).toBeCloseTo(1, 4);
    expect(persisted.body.floor.geometry.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'column' }),
        expect.objectContaining({ kind: 'fire_curtain' }),
      ]),
    );
    const floor = persisted.body.floor;
    expect(floor.iconGroups.length).toBeGreaterThan(0);
    expect(floor.iconGroups.flatMap((g: any) => g.icons)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'toilet-male' }),
        expect.objectContaining({ kind: 'toilet-female' }),
        expect.objectContaining({ kind: 'emergency-exit' }),
      ]),
    );
    for (const a of [...floor.labels, ...floor.iconGroups]) {
      expect(
        area(intersection(rectangle(a.x, a.y, a.width, a.height), floor.geometry.boundary)),
      ).toBeLessThan(1e-7);
    }
    const exported = await http
      .get(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}/preview`)
      .query({ key: hall.key })
      .set(auth())
      .expect(200);
    expect(exported.body.config.data[0].helper_text.length).toBe(floor.iconGroups.length);
  }, 90000);
  it('imports and saves four reviewed CAD halls independently with their foyers', async () => {
    const uploaded = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', join(__dirname, 'fixtures/floor-plan/dense-multiple-halls.pdf'))
      .expect(201);
    const url = `/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}`;
    let view: any;
    for (let attempt = 0; attempt < 280; attempt++) {
      view = (await http.get(url).set(auth()).expect(200)).body;
      if (view.status !== 'reading') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(view.status).toBe('ready');
    expect(view.halls.map((h: any) => h.name)).toEqual([
      'EXHIBITION HALL - 5',
      'EXHIBITION HALL - 4',
      'EXHIBITION HALL - 3',
      'EXHIBITION HALL - 2',
    ]);
    const page = view.pages[0];
    expect(page.calibration.source).toContain('CAD grid layer');
    const reviewed = await http
      .patch(url)
      .set(auth())
      .send({
        revision: view.revision,
        page: page.number,
        regions: page.regions.map((r: any) => ({
          ...r,
          confirmed: true,
          restrictionsConfirmed: true,
        })),
        objects: page.objects.map((o: any) => ({ ...o, confirmed: o.kind !== 'unknown' })),
        grid: page.grid,
        calibration: page.calibration,
        dimensions: page.dimensions,
      })
      .expect(200);
    for (const hall of reviewed.body.halls) {
      expect(hall.checks.filter((c: any) => c.status !== 'pass' && !c.overridable)).toEqual([]);
    }
    const saved = await http
      .post(url + '/commit')
      .set(auth())
      .send({
        revision: reviewed.body.revision,
        selections: reviewed.body.halls.map((h: any) => ({
          ...selection('unused'),
          key: h.key,
          name: h.name,
          acknowledgements: h.checks
            .filter((c: any) => c.status !== 'pass' && c.overridable)
            .map((c: any) => c.id),
        })),
      })
      .expect(201);
    expect(saved.body.map((s: any) => s.error)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(new Set(saved.body.map((s: any) => s.hallId)).size).toBe(4);
    for (let i = 0; i < saved.body.length; i++) {
      const hall = await http
        .get(`/api/orgs/sample/halls/${saved.body[i].hallId}`)
        .set(auth())
        .expect(200);
      expect(hall.body.floor.geometry.zones).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: `FOYER ${5 - i}F`, kind: 'foyer' }),
        ]),
      );
    }
  }, 180000);
  it('reads an uploaded PDF through the worker and persists separate hall candidates', async () => {
    const uploaded = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', join(__dirname, 'fixtures/floor-plan/12-12A.pdf'))
      .expect(201);
    let view: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      view = (
        await http
          .get(`/api/orgs/sample/venues/${venue}/floor-plans/${uploaded.body.id}`)
          .set(auth())
          .expect(200)
      ).body;
      if (view.status !== 'reading') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(view.status).toBe('ready');
    expect(view.halls.map((h: any) => h.name)).toEqual(['HALL 12A', 'HALL 12']);
    expect(view.pages[0].preview).toMatch(/^data:image\/png;base64,/);
    expect(view.halls.every((h: any) => !h.ready)).toBe(true);
    const again = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', join(__dirname, 'fixtures/floor-plan/12-12A.pdf'))
      .expect(201);
    expect(again.body.id).toBe(uploaded.body.id);
    await app.get(DataSource).getRepository(FloorPlanImportEntity).update(uploaded.body.id, {
      readerVersion: 'legacy',
    });
    const refreshed = await http
      .post(`/api/orgs/sample/venues/${venue}/floor-plans`)
      .set(auth())
      .attach('file', join(__dirname, 'fixtures/floor-plan/12-12A.pdf'))
      .expect(201);
    expect(refreshed.body.id).not.toBe(uploaded.body.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const freshView = (
        await http
          .get(`/api/orgs/sample/venues/${venue}/floor-plans/${refreshed.body.id}`)
          .set(auth())
          .expect(200)
      ).body;
      if (freshView.status !== 'reading') {
        expect(freshView.status).toBe('ready');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('The updated reader did not finish re-reading the old unsaved import.');
  }, 90000);
});
