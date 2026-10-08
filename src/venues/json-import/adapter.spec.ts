import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptJson } from './adapter';
import { area, bounds, rectangle } from '../floor-plan/geometry';
import { blankFloor, countAreas } from '../floor/hall-floor';
import { exportConfig } from '../floor-plan/review';
const convert = (value: unknown, mapping = {}) => adaptJson(JSON.stringify(value), mapping);
describe('Venue JSON adaptation', () => {
  it('adapts nested venues with metric polygons, holes and foyers independently', () => {
    const row = {
      unit: 'mm',
      boundary: [
        [
          [0, 0],
          [10000, 0],
          [10000, 20000],
          [0, 20000],
          [0, 0],
        ],
        [
          [2000, 2000],
          [3000, 2000],
          [3000, 3000],
          [2000, 3000],
          [2000, 2000],
        ],
      ],
      foyers: [{ name: 'Entry foyer', x: 0, y: 20000, width: 4000, height: 3000 }],
      columns: [{ x: 4000, y: 5000, width: 1000, height: 1000 }],
    };
    const result = convert({
      data: {
        halls: [
          { ...row, id: 'north', name: 'North' },
          { ...row, id: 'south', name: 'South' },
        ],
      },
    });
    expect(result.rows.map((r) => r.error)).toEqual([null, null]);
    const f = result.rows[0].floor!;
    expect([f.width, f.depth]).toEqual([10, 23]);
    expect(area(f.geometry!.hallBoundary)).toBe(199);
    expect(area(f.geometry!.zones[0].geometry)).toBe(12);
    expect(f.geometry!.objects[0].kind).toBe('column');
    expect(f.geometry!.objects[0].blocksStalls).toBe(true);
    expect(countAreas(f).column).toBe(1);
    expect(result.rows[0].externalId).not.toBe(result.rows[1].externalId);
  });
  it('asks for missing units and never defaults an unknown drawing to metres', () => {
    expect(convert({ width: 100, height: 200 }).rows[0].error).toMatch(/Choose source units/);
    expect(
      convert({ width: 100, height: 200 }, { unit: 'px', metresPerUnit: 0.1 }).rows[0].floor!.width,
    ).toBe(10);
  });
  it('maps arbitrary collection, dimensions and area fields into canonical geometry', () => {
    const raw = {
      payload: {
        spaces: [
          {
            ident: 'Custom',
            dimensions: { a: 30, b: 40 },
            shapes: [{ position: { h: 2, v: 3 }, size: { a: 1, b: 2 }, usage: 'structural' }],
          },
        ],
      },
    };
    const result = convert(raw, {
      halls: 'payload.spaces',
      name: 'ident',
      width: 'dimensions.a',
      depth: 'dimensions.b',
      areas: 'shapes',
      unit: 'm',
      areaFields: {
        x: 'position.h',
        y: 'position.v',
        width: 'size.a',
        height: 'size.b',
        kind: 'usage',
      },
      kinds: { structural: 'column' },
    });
    expect(result.rows[0].error).toBeNull();
    expect(result.rows[0].name).toBe('Custom');
    expect(bounds(result.rows[0].floor!.geometry!.objects[0].geometry)).toEqual({
      x: 2,
      y: 3,
      width: 1,
      height: 2,
    });
  });
  it('preserves native floors and rejects invalid canonical objects', () => {
    const native = blankFloor(30, 40);
    native.labels = [{ x: 2, y: 3, text: 'Gate A' }];
    expect(convert({ name: 'Native', floor: native }).rows[0].floor!.labels).toEqual(native.labels);
    native.geometry = convert({ width: 30, depth: 40, unit: 'm' }).rows[0].floor!.geometry;
    native.geometry!.objects.push({
      id: 'bad',
      kind: 'wall',
      geometry: [
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      ],
      label: 'bad',
      color: '#000000',
      blocksStalls: true,
      evidence: { source: 'text', detail: 'test' },
    });
    expect(convert(native).rows[0].error).toMatch(/ring|corners/);
  });
  it('accepts ITPO JSON through the generic option and keeps its metadata', () => {
    const data = readFileSync(
      join(__dirname, '../../../test/fixtures/itpo/hall-8-9-10.json'),
      'utf8',
    );
    const result = adaptJson(data);
    expect(result.rows.every((r) => !r.error)).toBe(true);
    expect(result.rows[0].source).toBe('itpo');
    expect(result.rows[0].floor!.areas.length).toBeGreaterThan(0);
    expect(result.rows[0].floor!.geometry).toBeDefined();
  });
  it('round-trips exported geometry without replacing polygon holes or off-grid restrictions', () => {
    const floor = convert({
      id: 'generic',
      name: 'Generic',
      unit: 'm',
      boundary: [rectangle(0, 0, 20, 30)[0][0], rectangle(2, 2, 1, 1)[0][0]],
      foyers: [{ name: 'Entry', x: 0, y: 30, width: 5, height: 3 }],
      objects: [{ kind: 'fire_curtain', x: 0, y: 10.5, width: 20, height: 1 }],
    }).rows[0].floor!;
    const roundTrip = convert(exportConfig('Generic', floor)).rows[0];
    expect(roundTrip.error).toBeNull();
    expect(roundTrip.floor!.geometry).toEqual(floor.geometry);
    expect(area(roundTrip.floor!.geometry!.hallBoundary)).toBe(599);
  });
  it('rejects supplied invalid grid and oversized annotation arrays instead of silently altering them', () => {
    expect(
      convert({ unit: 'm', width: 20, depth: 30, grid: { width: 'bad' } }).rows[0].error,
    ).toMatch(/Grid width/);
    const floor = blankFloor(20, 30);
    floor.legend = Array.from({ length: 1001 }, () => ({ label: 'Wall', showInView: true }));
    expect(convert(floor).rows[0].error).toMatch(/legend/);
    floor.legend = [];
    floor.iconGroups = [
      { x: 0, y: 0, icons: Array.from({ length: 101 }, () => ({ kind: 'entry', label: 'Exit' })) },
    ];
    expect(convert(floor).rows[0].error).toMatch(/100 icons/);
    expect(
      convert({ unit: 'm', width: 20, depth: 30, iconGroups: floor.iconGroups }).rows[0].error,
    ).toMatch(/100 icons/);
  });
  it('requires reviewed meanings for colour-only shapes and retains them after mapping', () => {
    const raw = {
      name: 'Hall',
      unit: 'm',
      width: 20,
      depth: 30,
      objects: [
        { type: 'rect', left: 2, top: 3, width: 1, height: 2, fill: '#cc7700', visible: false },
      ],
    };
    expect(convert(raw).areaTypes).toEqual(['#cc7700']);
    expect(convert(raw).rows[0].error).toMatch(/meaning/);
    const f = convert(raw, { kinds: { '#cc7700': 'fire_curtain' } }).rows[0].floor!;
    expect(f.geometry!.objects[0].blocksStalls).toBe(true);
    expect(area(f.geometry!.objects[0].geometry)).toBe(2);
  });
  it('does not silently discard unsupported canvas paths', () => {
    const r = convert({
      unit: 'm',
      width: 20,
      height: 30,
      objects: [
        {
          type: 'path',
          kind: 'wall',
          path: [
            ['M', 1, 1],
            ['L', 2, 2],
          ],
        },
      ],
    });
    expect(r.rows[0].floor).toBeNull();
    expect(r.rows[0].error).toMatch(/polygon export/);
  });
  it('rejects duplicate source identities, bad geometry, bad mapping and empty inputs', () => {
    expect(
      convert([
        { id: 'x', unit: 'm', width: 1, height: 1 },
        { id: 'x', unit: 'm', width: 1, height: 1 },
      ]).rows[1].error,
    ).toMatch(/Duplicate/);
    expect(
      convert({
        unit: 'm',
        boundary: [
          [0, 0],
          [1, 1],
          [0, 1],
          [1, 0],
        ],
      }).rows[0].error,
    ).toMatch(/cross|invalid|area/i);
    expect(() => convert({ width: 1, height: 2 }, { width: '__proto__.x' })).toThrow();
    expect(() => adaptJson('broken')).toThrow(/valid JSON/);
    expect(() => convert([])).toThrow(/hall object/);
  });
  it('converts feet and upward Y coordinates without stretching or clipping', () => {
    const r = convert(
      {
        unit: 'ft',
        boundary: rectangle(10, 10, 20, 30),
        areas: [{ kind: 'wall', x: 10, y: 10, width: 1, height: 3 }],
      },
      { yAxis: 'up' },
    ).rows[0];
    expect(r.error).toBeNull();
    expect(r.floor!.width).toBeCloseTo(6.096);
    expect(r.floor!.depth).toBeCloseTo(9.144);
    expect(bounds(r.floor!.geometry!.objects[0].geometry).y).toBeCloseTo(8.2296);
  });
  it('handles planar GeoJSON polygon features while rejecting known geographic CRS', () => {
    const feature = {
      type: 'Feature',
      properties: { name: 'Planar', unit: 'm' },
      geometry: { type: 'Polygon', coordinates: rectangle(0, 0, 20, 30)[0] },
    };
    expect(convert({ type: 'FeatureCollection', features: [feature] }).rows[0].error).toBeNull();
    expect(convert({ ...feature, crs: 'EPSG:4326' }).rows[0].error).toMatch(/Geographic/);
  });
});
