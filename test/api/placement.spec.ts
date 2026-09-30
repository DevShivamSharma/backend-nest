import '../setup-env';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';

const hall = { name: 'API test hall', shape: 'SQUARE', width: 60, length: 60 };
const stall = (extra = {}) => ({
  name: 'Stall',
  width: 2,
  length: 2,
  height: 3,
  posX: 0,
  posZ: 0,
  openSides: ['FRONT'],
  ...extra,
});
let ids: number[] = [];
let db: Client;
test.beforeAll(async () => {
  db = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: 'stall_designer_test',
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  });
  await db.connect();
  expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe(
    'stall_designer_test',
  );
});
test.afterAll(async () => {
  await db.end();
});
test.afterEach(async ({ request }) => {
  for (const id of ids) await request.delete(`/api/layout/${id}`);
  ids = [];
});
async function save(request: APIRequestContext, data: object) {
  const response = await request.post('/api/layout/save', { data: { hall, ...data } });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(201);
  ids.push(body.layout.id);
  return body;
}
async function splitParent(request: APIRequestContext) {
  return save(request, {
    hall: { ...hall, rules: { minPassageWidth: { B2B: 5, B2C: 5 }, peripheralClearance: 0 } },
    stalls: [stall({ stallNumber: '5-10', width: 12, length: 4 })],
  });
}
const split = (key = 'split-one') => ({
  idempotencyKey: key,
  children: [stall({ posX: -4, width: 3, length: 4 }), stall({ posX: 4, width: 3, length: 4 })],
});

test('default, 3 m / 5 m open-side passage and exact width; invalid inputs write no records', async ({
  request,
}) => {
  for (const width of [3, 5]) {
    const h = {
      ...hall,
      rules: { minPassageWidth: { B2B: width, B2C: width }, peripheralClearance: 0 },
    };
    // The second stall stands in front of the first one's open FRONT side; a shared wall on a
    // closed side (third stall) needs no passage.
    const stalls = [
      stall({ posX: -29, posZ: -29 }),
      stall({ posX: -29, posZ: -27 + width }),
      stall({ posX: -27, posZ: -29 }),
    ];
    await save(request, { hall: h, stalls });
    const response = await request.post('/api/layout/save', {
      data: {
        hall: h,
        stalls: [stalls[0], { ...stalls[1], posZ: stalls[1].posZ - 0.01 }, stalls[2]],
      },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OPEN_SIDE_BLOCKED', requiredWidth: width }),
      ]),
    );
  }
  for (const width of [2.99, 5.01, '3', null]) {
    const before = (await db.query('SELECT count(*)::int AS count FROM layouts')).rows[0].count;
    const response = await request.post('/api/layout/save', {
      data: { hall: { ...hall, rules: { minPassageWidth: { B2B: width } } }, stalls: [] },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).violations[0].code).toBe('INVALID_PASSAGE_WIDTH');
    expect((await db.query('SELECT count(*)::int AS count FROM layouts')).rows[0].count).toBe(
      before,
    );
  }
  await save(request, { stalls: [stall(), stall({ posX: 5 })] });
});

test('rotated back-to-back survives reload; invalid open-side update rolls back', async ({
  request,
}) => {
  const saved = await save(request, {
    stalls: [stall({ rotation: 90, openSides: ['BACK'] }), stall({ rotation: 90, posX: -2 })],
  });
  const loaded = await (await request.get(`/api/layout/${saved.layout.id}`)).json();
  expect(loaded.stalls).toEqual(saved.stalls);
  const bad = await request.put(`/api/layout/${saved.layout.id}`, {
    data: { hall, stalls: [{ ...loaded.stalls[0], openSides: ['FRONT'] }, loaded.stalls[1]] },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).violations).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'OPEN_SIDE_BLOCKED' })]),
  );
  expect((await (await request.get(`/api/layout/${saved.layout.id}`)).json()).stalls).toEqual(
    saved.stalls,
  );
});

test('irregular outside notch cannot be used as passage and rotated footprint cannot cross it', async ({
  request,
}) => {
  const boundary = [
    { x: -30, z: -30 },
    { x: 30, z: -30 },
    { x: 30, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 30 },
    { x: -30, z: 30 },
  ];
  for (const s of [stall({ posX: 5, posZ: -2 }), stall({ posX: 5, posZ: -1, rotation: 45 })]) {
    const res = await request.post('/api/layout/save', {
      data: { hall: { ...hall, boundary }, stalls: [s] },
    });
    expect(res.status()).toBe(400);
    expect(
      (await res.json()).violations.some((v: { code: string }) =>
        ['OUTSIDE_HALL', 'OPEN_SIDE_PASSAGE'].includes(v.code),
      ),
    ).toBe(true);
  }
});

test('hall update cannot bypass final validation of existing stalls', async ({ request }) => {
  const saved = await save(request, { stalls: [stall({ posX: 8 })] });
  const res = await request.put(`/api/halls/${saved.hall.id}`, { data: { ...hall, width: 10 } });
  expect(res.status(), await res.text()).toBe(400);
  expect((await res.json()).violations).toContainEqual(
    expect.objectContaining({ code: 'OUTSIDE_HALL' }),
  );
  expect((await (await request.get(`/api/layout/${saved.layout.id}`)).json()).hall.width).toBe(60);
});

test('move, rotation, resize and width changes all revalidate the complete PUT state', async ({
  request,
}) => {
  const saved = await save(request, { stalls: [stall({ posX: 29, openSides: ['LEFT'] })] });
  for (const change of [{ posX: 29.1 }, { rotation: 45 }, { width: 3 }]) {
    const response = await request.put(`/api/layout/${saved.layout.id}`, {
      data: { hall, stalls: [{ ...saved.stalls[0], ...change }] },
    });
    expect(response.status(), await response.text()).toBe(400);
    expect((await response.json()).violations).toContainEqual(
      expect.objectContaining({ code: 'OUTSIDE_HALL' }),
    );
  }
  // 3 m in front of the first stall's open FRONT side: enough for 3 m, not for 5 m.
  const three = await save(request, { stalls: [stall(), stall({ posZ: 5 })] });
  const five = await request.put(`/api/layout/${three.layout.id}`, {
    data: {
      hall: { ...hall, rules: { minPassageWidth: { B2B: 5 }, peripheralClearance: 0 } },
      stalls: three.stalls,
    },
  });
  expect(five.status()).toBe(400);
  expect((await five.json()).violations).toContainEqual(
    expect.objectContaining({ code: 'OPEN_SIDE_BLOCKED', requiredWidth: 5 }),
  );
});

test('duplicate identifiers and split child collisions are rejected without partial records', async ({
  request,
}) => {
  const duplicate = await request.post('/api/layout/save', {
    data: {
      hall,
      stalls: [stall({ stallNumber: '5-10' }), stall({ posX: 8, stallNumber: '5-10' })],
    },
  });
  expect(duplicate.status()).toBe(400);
  expect((await duplicate.json()).violations[0].code).toBe('INVALID_STALL_IDENTIFIER');
  const saved = await save(request, {
    stalls: [
      stall({ stallNumber: '5-10', width: 12, length: 4 }),
      stall({ stallNumber: '5-10-A', posX: 20 }),
    ],
  });
  const response = await request.post(`/api/layout/${saved.layout.id}/stalls/5-10/split`, {
    data: split(),
  });
  expect(response.status()).toBe(400);
  expect((await (await request.get(`/api/layout/${saved.layout.id}`)).json()).stalls).toEqual(
    saved.stalls,
  );
  expect(
    (
      await db.query('SELECT count(*)::int AS count FROM layout_splits WHERE layout_id=$1', [
        saved.layout.id,
      ])
    ).rows[0].count,
  ).toBe(0);
});

test('concurrent split retries create one set; lineage, width, geometry and numbers survive PUT/GET', async ({
  request,
}) => {
  const saved = await splitParent(request),
    url = `/api/layout/${saved.layout.id}/stalls/5-10/split`;
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request.post(url, { data: split() })),
  );
  for (const response of responses) expect(response.status(), await response.text()).toBe(200);
  const result = await responses[0].json();
  expect(result.stalls.map((s: { stallNumber: string }) => s.stallNumber)).toEqual([
    '5-10',
    '5-10-A',
    '5-10-B',
  ]);
  expect(result.stalls[0]).toMatchObject({ status: 'CANCELLED', isSplitParent: true });
  expect(result.stalls[1]).toMatchObject({ parentStallNumber: '5-10', width: 3, rotation: 0 });
  expect(
    (
      await db.query('SELECT count(*)::int AS count FROM layout_splits WHERE layout_id=$1', [
        saved.layout.id,
      ])
    ).rows[0].count,
  ).toBe(1);
  const update = await request.put(`/api/layout/${saved.layout.id}`, {
    data: { hall: result.hall, stalls: result.stalls },
  });
  expect(update.status(), await update.text()).toBe(200);
  const loaded = await (await request.get(`/api/layout/${saved.layout.id}`)).json();
  expect(loaded.hall.rules.minPassageWidth.B2B).toBe(5);
  expect(loaded.stalls.map((s: { stallNumber: string }) => s.stallNumber)).toEqual([
    '5-10',
    '5-10-A',
    '5-10-B',
  ]);
  expect(loaded.stalls[1].parentStallNumber).toBe('5-10');
  expect((await request.post(url, { data: split('another-key') })).status()).toBe(409);
  const conflict = split();
  conflict.children[0].posX = -3;
  expect((await request.post(url, { data: conflict })).status()).toBe(409);
  // A stale full-layout PUT must not resurrect the parent or erase the split.
  expect(
    (
      await request.put(`/api/layout/${saved.layout.id}`, {
        data: { hall: saved.hall, stalls: saved.stalls },
      })
    ).status(),
  ).toBe(409);
});

test('simultaneous different-key splits have exactly one winner', async ({ request }) => {
  const saved = await splitParent(request),
    url = `/api/layout/${saved.layout.id}/stalls/5-10/split`;
  const responses = await Promise.all(
    ['one', 'two'].map((key) => request.post(url, { data: split(key) })),
  );
  expect(responses.map((r) => r.status()).sort()).toEqual([200, 409]);
  expect(
    (
      await db.query('SELECT count(*)::int AS count FROM stalls WHERE layout_id=$1', [
        saved.layout.id,
      ])
    ).rows[0].count,
  ).toBe(3);
});

test('invalid split geometry and a late database failure both leave parent and ledger unchanged', async ({
  request,
}) => {
  const saved = await splitParent(request),
    id = saved.layout.id,
    url = `/api/layout/${id}/stalls/5-10/split`;
  const invalid = split();
  invalid.children[1].posX = 20;
  expect((await request.post(url, { data: invalid })).status()).toBe(400);
  // Force failure after the service has inserted the ledger and started replacing stall rows.
  await db.query(
    `CREATE OR REPLACE FUNCTION test_fail_split_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'FAIL_CHILD' THEN RAISE EXCEPTION 'test failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`,
  );
  await db.query(
    'CREATE TRIGGER test_fail_split_child BEFORE INSERT ON stalls FOR EACH ROW EXECUTE FUNCTION test_fail_split_child()',
  );
  try {
    const failing = split();
    failing.children[1].name = 'FAIL_CHILD';
    expect((await request.post(url, { data: failing })).status()).toBe(409);
    expect(
      (await db.query('SELECT count(*)::int AS count FROM layout_splits WHERE layout_id=$1', [id]))
        .rows[0].count,
    ).toBe(0);
    expect((await (await request.get(`/api/layout/${id}`)).json()).stalls).toEqual(saved.stalls);
  } finally {
    await db.query('DROP TRIGGER test_fail_split_child ON stalls');
    await db.query('DROP FUNCTION test_fail_split_child()');
  }
  expect((await request.post(url, { data: split() })).status()).toBe(200);
});

test('backend issues A..Z, AA, AB without parsing 5-10 as dimensions', async ({ request }) => {
  const bigHall = { ...hall, width: 240, length: 40 };
  const saved = await save(request, {
    hall: bigHall,
    stalls: [stall({ stallNumber: '5-10', width: 180, length: 4 })],
  });
  const children = Array.from({ length: 28 }, (_, i) => stall({ posX: -81 + i * 6 }));
  const res = await request.post(`/api/layout/${saved.layout.id}/stalls/5-10/split`, {
    data: { idempotencyKey: 'alphabet', children },
  });
  expect(res.status(), await res.text()).toBe(200);
  const numbers = (await res.json()).stalls.map((s: { stallNumber: string }) => s.stallNumber);
  expect(numbers.slice(1, 4)).toEqual(['5-10-A', '5-10-B', '5-10-C']);
  expect(numbers.slice(-3)).toEqual(['5-10-Z', '5-10-AA', '5-10-AB']);
  expect(
    (await (await request.get(`/api/layout/${saved.layout.id}`)).json()).stalls.map(
      (s: { stallNumber: string }) => s.stallNumber,
    ),
  ).toEqual(numbers);
});
