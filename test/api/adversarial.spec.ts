import '../setup-env';
import { test, expect, type APIRequestContext } from '@playwright/test';

const hall = { name: 'Adversarial audit', shape: 'SQUARE', width: 80, length: 60 };
const stall = (extra: Record<string, unknown> = {}) => ({
  name: 'Audit stall',
  width: 2,
  length: 2,
  height: 3,
  posX: 0,
  posZ: 0,
  openSides: ['FRONT'],
  ...extra,
});
let ids: number[] = [];
async function post(request: APIRequestContext, data: object) {
  const response = await request.post('/api/layout/save', { data: { hall, ...data } });
  const body = await response.json();
  if (response.status() === 201) ids.push(body.layout.id);
  return { response, body };
}
async function save(request: APIRequestContext, data: object) {
  const { response, body } = await post(request, data);
  expect(response.status(), JSON.stringify(body)).toBe(201);
  return body;
}
test.afterEach(async ({ request }) => {
  for (const id of ids) expect((await request.delete(`/api/layout/${id}`)).status()).toBe(200);
  ids = [];
});

test('ADV-A01 hall resize and layout dimension metadata remain consistent after reload', async ({
  request,
}) => {
  const saved = await save(request, { stalls: [stall()] });
  const updated = await request.put(`/api/halls/${saved.hall.id}`, {
    data: { ...hall, width: 90, length: 70 },
  });
  expect(updated.status(), await updated.text()).toBe(200);
  const loaded = await (await request.get(`/api/layout/${saved.layout.id}`)).json();
  expect(loaded.hall.width).toBe(90);
  expect(loaded.layout.hallWidth).toBe(loaded.hall.width);
  expect(loaded.layout.hallLength).toBe(loaded.hall.length);
  expect(loaded.stalls).toEqual(saved.stalls);
});

test('ADV-A02 automatic numbering overflow returns 400 and writes no layout', async ({
  request,
}) => {
  const before = await (await request.get('/api/layout/list')).json();
  const { response } = await post(request, {
    stalls: [stall({ posX: -10, stallNumber: 'STALL-2147483645' }), stall(), stall({ posX: 10 })],
  });
  expect(response.status()).toBe(400);
  expect(await (await request.get('/api/layout/list')).json()).toEqual(before);
});

test('ADV-A03 unrepresentable finite geometry returns structured 400, not an internal error', async ({
  request,
}) => {
  for (const stalls of [[stall({ posX: 1e20 })], [stall(), stall({ posX: 1e20 })]]) {
    const { response, body } = await post(request, {
      hall: { ...hall, width: 1e22, length: 1e22 },
      stalls,
    });
    expect(response.status(), JSON.stringify(body)).toBe(400);
    expect(body.violations).toContainEqual(expect.objectContaining({ code: 'INVALID_DIMENSIONS' }));
  }
});

test('ADV-A04 B2B-to-B2C change revalidates selected width and rolls back', async ({ request }) => {
  const h = { ...hall, rules: { minPassageWidth: { B2B: 3, B2C: 5 }, peripheralClearance: 0 } };
  const saved = await save(request, {
    hall: h,
    eventType: 'B2B',
    stalls: [stall(), stall({ posX: 5 })],
  });
  const response = await request.put(`/api/layout/${saved.layout.id}`, {
    data: { hall: h, eventType: 'B2C', stalls: saved.stalls },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).violations).toContainEqual(
    expect.objectContaining({ requiredWidth: 5 }),
  );
  expect(
    (await (await request.get(`/api/layout/${saved.layout.id}`)).json()).layout.eventType,
  ).toBe('B2B');
});

test('ADV-A05 idempotency ignores object key order but detects reordered children', async ({
  request,
}) => {
  const saved = await save(request, {
    stalls: [stall({ stallNumber: '5-10', width: 12, length: 4 })],
  });
  const url = `/api/layout/${saved.layout.id}/stalls/5-10/split`;
  const children = [stall({ posX: -4 }), stall({ posX: 4 })];
  const first = await request.post(url, { data: { idempotencyKey: 'canonical', children } });
  expect(first.status(), await first.text()).toBe(200);
  const reversedKeys = children.map((s) => Object.fromEntries(Object.entries(s).reverse()));
  const replay = await request.post(url, {
    data: { children: reversedKeys, idempotencyKey: 'canonical' },
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).stalls).toEqual((await first.json()).stalls);
  expect(
    (
      await request.post(url, {
        data: { idempotencyKey: 'canonical', children: [...children].reverse() },
      })
    ).status(),
  ).toBe(409);
});

test('ADV-A06 nested split lineage survives forged PUT fields and cannot resurrect parents', async ({
  request,
}) => {
  const saved = await save(request, {
    stalls: [stall({ stallNumber: '5-10', width: 30, length: 4 })],
  });
  const url = `/api/layout/${saved.layout.id}`;
  expect(
    (
      await request.post(`${url}/stalls/5-10/split`, {
        data: {
          idempotencyKey: 'outer',
          children: [
            stall({ width: 12, length: 4, posX: -9 }),
            stall({ width: 12, length: 4, posX: 9 }),
          ],
        },
      })
    ).status(),
  ).toBe(200);
  const nested = await request.post(`${url}/stalls/5-10-A/split`, {
    data: { idempotencyKey: 'inner', children: [stall({ posX: -12 }), stall({ posX: -6 })] },
  });
  expect(nested.status(), await nested.text()).toBe(200);
  const body = await nested.json();
  expect(body.stalls.map((s: any) => s.stallNumber)).toEqual([
    '5-10',
    '5-10-A',
    '5-10-B',
    '5-10-A-A',
    '5-10-A-B',
  ]);
  const forged = body.stalls.map((s: any) => ({
    ...s,
    parentStallNumber: 'FAKE',
    isSplitParent: false,
  }));
  const put = await request.put(url, { data: { hall: body.hall, stalls: forged } });
  expect(put.status(), await put.text()).toBe(200);
  const loaded = await (await request.get(url)).json();
  expect(loaded.stalls[3].parentStallNumber).toBe('5-10-A');
  expect(loaded.stalls[1].isSplitParent).toBe(true);
  const resurrection = loaded.stalls.map((s: any) => ({ ...s, status: 'AVAILABLE' }));
  expect(
    (await request.put(url, { data: { hall: loaded.hall, stalls: resurrection } })).status(),
  ).toBe(409);
  expect((await (await request.get(url)).json()).stalls).toEqual(loaded.stalls);
});

test('ADV-A07 overlong generated child identifiers reject the entire split', async ({
  request,
}) => {
  const number = 'P'.repeat(254);
  const saved = await save(request, {
    stalls: [stall({ stallNumber: number, width: 12, length: 4 })],
  });
  const url = `/api/layout/${saved.layout.id}`;
  const response = await request.post(`${url}/stalls/${number}/split`, {
    data: {
      idempotencyKey: 'length-limit',
      children: [stall({ posX: -4 }), stall({ posX: 4 })],
    },
  });
  expect(response.status()).toBe(400);
  expect((await (await request.get(url)).json()).stalls).toEqual(saved.stalls);
});

test('ADV-A08 unauthorized seed import cannot bypass placement validation', async ({ request }) => {
  const data = { hall, stalls: [stall(), stall()] };
  const cases: Record<string, string>[] = [{}, { 'x-seed-token': 'incorrect-audit-token' }];
  for (const headers of cases) {
    expect((await request.post('/api/layout/seed-import', { data, headers })).status()).toBe(404);
  }
  expect((await post(request, data)).response.status()).toBe(400);
});

test('ADV-A09 rotated corners at previously crashing angles save and reload exactly', async ({
  request,
}) => {
  for (const rotation of [20.37, 60.37, 90.37]) {
    const t = (rotation / 180) * Math.PI;
    const transform = (x: number, z: number) => ({
      x: 137 + x * Math.cos(t) - z * Math.sin(t),
      z: -83 + x * Math.sin(t) + z * Math.cos(t),
    });
    const at = (x: number, z: number) => {
      const p = transform(x, z);
      return stall({ posX: p.x, posZ: p.z, rotation });
    };
    const h = {
      ...hall,
      boundary: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
      ].map(([x, z]) => transform(x, z)),
      rules: { minPassageWidth: { B2B: 3.5, B2C: 3.5 }, peripheralClearance: 0 },
    };
    const saved = await save(request, { hall: h, stalls: [at(-19, -19), at(-13.5, -19)] });
    const loaded = await (await request.get(`/api/layout/${saved.layout.id}`)).json();
    expect(loaded.stalls).toEqual(saved.stalls);
    expect(loaded.hall.boundary).toEqual(h.boundary);
    const audit = await request.post(`/api/layout/${saved.layout.id}/validate`);
    expect(audit.status()).toBe(200);
    expect(await audit.json()).toMatchObject({ valid: true, entries: [] });
  }
});
