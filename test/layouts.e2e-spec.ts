import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * Full HTTP -> service -> PostgreSQL round trips against `stall_designer_test`.
 * Persistence is asserted by querying the tables directly, not by trusting the API's own
 * responses.
 */
describe('Layouts API (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let db: DataSource;

  const squareHall = {
    id: 1,
    name: 'Main Hall',
    shape: 'SQUARE',
    width: 40,
    length: 40,
    radius: 0,
  };
  const stall = (posX: number, posZ: number, extra: object = {}) => ({
    name: 'Shop',
    width: 5,
    length: 5,
    height: 4,
    posX,
    posZ,
    color: '#3498db',
    gateSide: 'FRONT',
    ...extra,
  });
  const body = (extra: object = {}) => ({
    layoutName: 'Expo 2026',
    hall: squareHall,
    stalls: [stall(-8, 12, { name: 'Alpha' }), stall(0, 0, { name: 'Beta', gateSide: 'left' })],
    ...extra,
  });

  const count = async (table: string): Promise<number> =>
    (await db.query(`SELECT COUNT(*) AS c FROM ${table}`))[0].c;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    db = app.get(DataSource);
    expect(db.options.database).toBe('stall_designer_test');
    await db.runMigrations();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE stalls, layouts, hall RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('POST /api/layout/save', () => {
    it('201, the Java envelope, and rows in all three tables', async () => {
      const res = await http().post('/api/layout/save').send(body()).expect(201);

      expect(res.body.message).toBe('Layout saved successfully.');
      expect(res.body.layout).toMatchObject({
        name: 'Expo 2026',
        hallWidth: 40,
        hallLength: 40,
        hallHeight: 0,
      });
      expect(res.body.hall).toMatchObject({ name: 'Main Hall', shape: 'SQUARE', width: 40 });
      expect(res.body.stalls).toHaveLength(2);
      expect(res.body.layout.hall).toEqual(res.body.hall);
      expect(res.body.layout.stalls).toEqual(res.body.stalls);
      expect(res.body.stalls[1]).toMatchObject({
        name: 'Beta',
        gateSide: 'LEFT',
        posX: 0,
        posZ: 0,
      });
      expect(res.body.stalls[0]).not.toHaveProperty('layoutId');

      expect(await count('hall')).toBe(1);
      expect(await count('layouts')).toBe(1);
      expect(await count('stalls')).toBe(2);
    });

    it('ids are JSON numbers, start at 1000, and the client hall id is ignored (G-5, BR-18)', async () => {
      const res = await http().post('/api/layout/save').send(body()).expect(201);

      expect(res.body.layout.id).toBe(1000);
      expect(res.body.hall.id).toBe(1000);
      expect(typeof res.body.stalls[0].id).toBe('number');
    });

    it('saving the same hall twice creates two hall rows (BR-19)', async () => {
      await http().post('/api/layout/save').send(body()).expect(201);
      await http().post('/api/layout/save').send(body()).expect(201);

      expect(await count('hall')).toBe(2);
    });

    it('a rejected request writes NOTHING', async () => {
      const res = await http()
        .post('/api/layout/save')
        .send(body({ stalls: [stall(0, 0, { name: 'A' }), stall(2, 0, { name: 'B' })] }))
        .expect(400);

      expect(res.body).toMatchObject({
        success: false,
        status: 400,
        violations: expect.arrayContaining([expect.objectContaining({ code: 'STALL_OVERLAP' })]),
      });
      expect(await count('hall')).toBe(0);
      expect(await count('layouts')).toBe(0);
    });

    it('out of bounds -> 400 with structured geometry', async () => {
      const res = await http()
        .post('/api/layout/save')
        .send(body({ stalls: [stall(-8, 18)] }))
        .expect(400);

      expect(res.body.violations).toContainEqual(
        expect.objectContaining({ code: 'OUTSIDE_HALL', stallIndex: 0 }),
      );
    });

    it('missing hall -> the Java message, not a generic pipe message', async () => {
      const res = await http().post('/api/layout/save').send({ layoutName: 'x' }).expect(400);

      expect(res.body.message).toBe('Hall data is required.');
    });

    it('wrong type -> 400 (ADR-014; the Java answered 500)', async () => {
      const res = await http()
        .post('/api/layout/save')
        .send(body({ hall: { ...squareHall, width: 'wide' } }))
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('malformed JSON -> 400 in the standard envelope', async () => {
      const res = await http()
        .post('/api/layout/save')
        .set('Content-Type', 'application/json')
        .send('{"hall": ')
        .expect(400);

      expect(Object.keys(res.body)).toEqual(['success', 'status', 'message']);
    });

    it('saves a circular layout with hallWidth 0', async () => {
      const res = await http()
        .post('/api/layout/save')
        .send({
          hall: { name: 'Lounge', shape: 'circle', width: 0, length: 0, radius: 20 },
          stalls: [stall(0, 0)],
        })
        .expect(201);

      expect(res.body.layout).toMatchObject({ name: 'Lounge', hallWidth: 0, hallLength: 0 });
      expect(res.body.hall).toMatchObject({ shape: 'CIRCLE', radius: 20 });
    });
  });

  describe('GET /api/layout/:id', () => {
    it('returns what was saved, message null, stalls in insertion order', async () => {
      const saved = (await http().post('/api/layout/save').send(body())).body;
      const res = await http().get(`/api/layout/${saved.layout.id}`).expect(200);

      expect(res.body.message).toBeNull();
      expect(res.body.layout).toEqual(saved.layout);
      expect(res.body.stalls.map((s: { name: string }) => s.name)).toEqual(['Alpha', 'Beta']);
    });

    it('unknown id -> 400 "Layout not found" (ADR-003)', async () => {
      const res = await http().get('/api/layout/424242').expect(400);

      expect(res.body).toEqual({
        success: false,
        status: 400,
        message: 'Layout not found: 424242',
      });
    });

    it('non-numeric id -> 400', async () => {
      await http().get('/api/layout/abc').expect(400);
    });
  });

  describe('PUT /api/layout/:id', () => {
    it('keeps layout and hall ids, replaces every stall with new ids (BR-16)', async () => {
      const saved = (await http().post('/api/layout/save').send(body())).body;
      const oldStallIds = saved.stalls.map((s: { id: number }) => s.id);

      const res = await http()
        .put(`/api/layout/${saved.layout.id}`)
        .send(
          body({
            layoutName: 'Renamed',
            hall: { ...squareHall, name: 'Hall B', width: 50 },
            stalls: [stall(10, 10, { name: 'Only' })],
          }),
        )
        .expect(200);

      expect(res.body.message).toBe('Layout updated successfully.');
      expect(res.body.layout.id).toBe(saved.layout.id);
      expect(res.body.hall.id).toBe(saved.hall.id);
      expect(res.body.layout).toMatchObject({ name: 'Renamed', hallWidth: 50 });
      expect(res.body.stalls).toHaveLength(1);
      expect(oldStallIds).not.toContain(res.body.stalls[0].id);

      expect(await count('hall')).toBe(1);
      expect(await count('stalls')).toBe(1);
    });

    it('an invalid update leaves the stored layout untouched', async () => {
      const saved = (await http().post('/api/layout/save').send(body())).body;

      await http()
        .put(`/api/layout/${saved.layout.id}`)
        .send(body({ stalls: [stall(99, 0)] }))
        .expect(400);

      const after = (await http().get(`/api/layout/${saved.layout.id}`)).body;
      expect(after.stalls).toEqual(saved.stalls);
    });

    it('unknown id -> 400', async () => {
      const res = await http().put('/api/layout/424242').send(body()).expect(400);

      expect(res.body.message).toBe('Layout not found: 424242');
    });
  });

  describe('DELETE /api/layout/:id', () => {
    it('200 with {message,id}; hall and stalls rows are gone too (BR-20)', async () => {
      const keep = (await http().post('/api/layout/save').send(body())).body;
      const drop = (await http().post('/api/layout/save').send(body())).body;

      const res = await http().delete(`/api/layout/${drop.layout.id}`).expect(200);

      expect(res.body).toEqual({ message: 'Layout deleted successfully.', id: drop.layout.id });
      expect(await count('layouts')).toBe(1);
      expect(await count('hall')).toBe(1);
      expect(await count('stalls')).toBe(2);
      await http().get(`/api/layout/${keep.layout.id}`).expect(200);
    });

    it('unknown id -> 400', async () => {
      await http().delete('/api/layout/424242').expect(400);
    });
  });

  describe('GET /api/layouts', () => {
    it('empty database -> []', async () => {
      expect((await http().get('/api/layouts').expect(200)).body).toEqual([]);
    });

    it('newest first, exact LayoutSummary shape, numeric stallCount (BR-21)', async () => {
      await http()
        .post('/api/layout/save')
        .send(body({ layoutName: 'First' }));
      await http()
        .post('/api/layout/save')
        .send(body({ layoutName: 'Second', stalls: [] }));

      const res = await http().get('/api/layouts').expect(200);

      expect(res.body.map((l: { name: string }) => l.name)).toEqual(['Second', 'First']);
      expect(res.body[1]).toEqual({
        id: 1000,
        name: 'First',
        hallId: 1000,
        hallName: 'Main Hall',
        shape: 'SQUARE',
        hallWidth: 40,
        hallLength: 40,
        radius: 0,
        stallCount: 2,
      });
      expect(res.body[0].stallCount).toBe(0);
    });

    it('/api/layout/list (deprecated duplicate) returns the same thing', async () => {
      await http().post('/api/layout/save').send(body());

      const a = (await http().get('/api/layouts')).body;
      const b = (await http().get('/api/layout/list').expect(200)).body;
      expect(b).toEqual(a);
    });
  });

  describe('cross-cutting', () => {
    it('readiness reports the database up', async () => {
      expect((await http().get('/health/ready').expect(200)).body).toEqual({
        status: 'ok',
        database: 'up',
      });
    });

    it('CORS: allowed origin echoed, others not', async () => {
      const ok = await http().get('/api/layouts').set('Origin', 'http://localhost:4200');
      const bad = await http().get('/api/layouts').set('Origin', 'http://evil.example.com');

      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4200');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
