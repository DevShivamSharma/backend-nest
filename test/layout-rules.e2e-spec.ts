import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * The rule-driven editor over real HTTP and PostgreSQL (`stall_designer_test`): stall types,
 * structured placement rejections, stable stall numbers across PUT, cancellation, and the audit.
 */
describe('Layout rules API (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let db: DataSource;

  // 40 x 20 m hall with an outline polygon and rules (defaults: 3 m B2B passage, 1 m wall).
  const ruledHall = {
    name: 'Ruled Hall',
    shape: 'SQUARE',
    width: 40,
    length: 20,
    radius: 0,
    boundary: [
      { x: -20, z: -10 },
      { x: 20, z: -10 },
      { x: 20, z: 10 },
      { x: -20, z: 10 },
    ],
    zones: [
      {
        id: 'zone-1',
        kind: 'PASSAGE',
        label: 'Compulsory passage',
        polygon: [
          { x: 10, z: -9 },
          { x: 12, z: -9 },
          { x: 12, z: 9 },
          { x: 10, z: 9 },
        ],
      },
    ],
    rules: {},
  };
  const stall = (posX: number, extra: object = {}) => ({
    name: 'Shop',
    width: 3,
    length: 2,
    height: 4,
    posX,
    posZ: 0,
    gateSide: 'FRONT',
    ...extra,
  });

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

  it('GET /api/stall-types serves the configured sizes', async () => {
    const res = await http().get('/api/stall-types').expect(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual([
      'stall-3x2',
      'stall-4x2',
      'stall-10x10',
    ]);
    expect(res.body[0]).toEqual({
      id: 'stall-3x2',
      label: '3 × 2',
      width: 3,
      height: 2,
      unit: 'meter',
    });
  });

  it('rejects a placement with 400, a readable message and structured violations', async () => {
    const res = await http()
      .post('/api/layout/save')
      .send({ layoutName: 'L', hall: ruledHall, stalls: [stall(11)] })
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      status: 400,
      message:
        'Stall 0 (Shop) placement rejected: Stall intersects or is too close to Compulsory passage.',
      violations: [
        expect.objectContaining({
          stallIndex: 0,
          stallNumber: null,
          code: 'RESTRICTED_ZONE',
          ruleRef: 'Placement',
          geometry: expect.arrayContaining([expect.objectContaining({ type: 'polygon' })]),
        }),
      ],
    });
    expect((await db.query('SELECT COUNT(*) AS c FROM layouts'))[0].c).toBe(0);
  });

  it('keeps stall numbers across PUT, never reuses one, and persists cancellation', async () => {
    const saved = await http()
      .post('/api/layout/save')
      .send({ layoutName: 'L', hall: ruledHall, stalls: [stall(-12), stall(-6), stall(0)] })
      .expect(201);
    const id = saved.body.layout.id;
    expect(saved.body.stalls.map((s: { stallNumber: string }) => s.stallNumber)).toEqual([
      'STALL-001',
      'STALL-002',
      'STALL-003',
    ]);

    // Cancel STALL-002, remove STALL-003, add a new stall.
    const [one, two] = saved.body.stalls;
    const updated = await http()
      .put(`/api/layout/${id}`)
      .send({
        layoutName: 'L',
        hall: ruledHall,
        stalls: [one, { ...two, status: 'CANCELLED' }, stall(0)],
      })
      .expect(200);

    expect(
      updated.body.stalls.map(
        (s: { stallNumber: string; status: string }) => `${s.stallNumber}:${s.status}`,
      ),
    ).toEqual(['STALL-001:AVAILABLE', 'STALL-002:CANCELLED', 'STALL-004:AVAILABLE']);

    const rows = await db.query(`SELECT next_stall_seq AS seq FROM layouts WHERE id = $1`, [id]);
    expect(rows[0].seq).toBe(5);
  });

  it('POST /api/layout/{id}/validate reports existing problems without blocking', async () => {
    // Existing state written by a trusted import is represented here by a hall without rules
    // that later gains them: save is allowed, then the rules are switched on through PUT.
    const saved = await http()
      .post('/api/layout/save')
      .send({ layoutName: 'L', hall: { ...ruledHall, rules: null }, stalls: [stall(-18.5)] })
      .expect(201);
    const id = saved.body.layout.id;
    await http()
      .put(`/api/layout/${id}`)
      .send({ layoutName: 'L', hall: ruledHall, stalls: saved.body.stalls })
      .expect(400);
    // Simulate legacy data imported before validation, then audit it without mutation.
    await db.query('UPDATE hall SET rules = $1 WHERE id = $2', [
      JSON.stringify({}),
      saved.body.hall.id,
    ]);

    const audit = await http().post(`/api/layout/${id}/validate`).expect(200);
    expect(audit.body).toMatchObject({ layoutId: id, ruleDriven: true, valid: false });
    expect(audit.body.entries[0].violations[0].code).toBe('PERIPHERAL_CLEARANCE');
  });
});
