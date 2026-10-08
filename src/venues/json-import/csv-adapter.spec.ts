import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptCsv } from './csv-adapter';
import { area } from '../floor-plan/geometry';
import { itpoRowToFloor, readItpoHallRows } from '../../integrations/itpo/itpo-hall-layout';
const csv = (rows: unknown[][]) =>
  rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
describe('Venue CSV adaptation', () => {
  it('reads all 29 sample halls and preserves source restrictions, icons, exits and legends', () => {
    const content = readFileSync(
      join(__dirname, '../../../test/fixtures/csv/hall-layouts.csv'),
      'utf8',
    );
    const result = adaptCsv(content);
    const source = readItpoHallRows(content, 'csv');
    expect(result.rows).toHaveLength(29);
    expect(result.rows.every((r) => r.floor && !r.error && r.source === 'csv')).toBe(true);
    expect(result.rows.map((r) => r.externalId)).toEqual(source.map((r) => r.hallId));
    result.rows.forEach((r, i) => {
      const expected = itpoRowToFloor(source[i]).floor;
      expect(r.floor).toMatchObject(expected);
    });
    expect(result.rows[0].name).toBe('Hall 56');
    expect(result.rows[0].floor!.geometry!.objects.length).toBeGreaterThan(0);
    expect(result.rows.find((r) => r.externalId === '62')!.floor!.areas).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'fire_curtain', hidden: true })]),
    );
  });
  it('adapts generic CSV columns and embedded foyer/column data with metric conversion', () => {
    const result = adaptCsv(
      csv([
        ['id', 'name', 'width', 'depth', 'unit', 'foyers', 'columns'],
        [
          'north',
          'North, "Annex"\nGround',
          20000,
          30000,
          'mm',
          JSON.stringify([{ name: 'Entry', x: 0, y: 30000, width: 5000, height: 3000 }]),
          JSON.stringify([{ x: 5000, y: 5000, width: 1000, height: 1000 }]),
        ],
        ['south', 'South', 20, 30, 'm', 'NULL', '[]'],
      ]),
    );
    expect(result.rows.map((r) => r.error)).toEqual([null, null]);
    const f = result.rows[0].floor!;
    expect([f.width, f.depth]).toEqual([20, 33]);
    expect(area(f.geometry!.hallBoundary)).toBe(600);
    expect(area(f.geometry!.zones[0].geometry)).toBe(15);
    expect(f.geometry!.objects[0].kind).toBe('column');
    expect(result.rows[0].name).toContain('North, "Annex"');
    expect(result.rows[0].externalId).not.toBe(result.rows[1].externalId);
  });
  it('maps other venues’ columns and paths inside JSON cells without assuming unknown units', () => {
    const content =
      '\uFEFF' +
      csv([
        ['id', 'title', 'dimensions', 'shapes'],
        [
          'a',
          'Custom',
          '{"w":20,"d":30}',
          '[{"x":2,"y":3,"width":1,"height":2,"kind":"structure"}]',
        ],
      ]);
    const mapping = { width: 'dimensions.w', depth: 'dimensions.d', areas: 'shapes' };
    expect(adaptCsv(content, mapping).rows[0].error).toMatch(/source units/);
    const r = adaptCsv(content, { ...mapping, unit: 'm', kinds: { structure: 'column' } }).rows[0];
    expect(r.error).toBeNull();
    expect(r.floor!.width).toBe(20);
    expect(r.floor!.geometry!.objects[0].kind).toBe('column');
  });
  it('reports broken structured cells per hall while retaining valid rows', () => {
    const result = adaptCsv(
      csv([
        ['id', 'width', 'depth', 'unit', 'foyers'],
        ['bad', 20, 30, 'm', '[broken'],
        ['good', 20, 30, 'm', '[]'],
      ]),
    );
    expect(result.rows[0].error).toMatch(/row 2.*foyers.*invalid JSON/);
    expect(result.rows[0].floor).toBeNull();
    expect(result.rows[1].error).toBeNull();
    expect(result.rows[1].floor).not.toBeNull();
  });
  it('rejects invalid CSV structure and duplicate source hall identities', () => {
    expect(() => adaptCsv('id,width,width\na,20,30')).toThrow(/unique/);
    expect(() => adaptCsv('id,,depth\na,20,30')).toThrow(/non-empty/);
    expect(() => adaptCsv('id,width,depth\na,20')).toThrow(/row 2.*columns/);
    expect(() => adaptCsv('id,name\na,"open')).toThrow(/quoted field/);
    expect(() => adaptCsv('id,name')).toThrow(/hall rows/);
    const rows = adaptCsv('id,width,depth,unit\na,20,30,m\na,20,30,m').rows;
    expect(rows[1].error).toMatch(/Duplicate/);
  });
});
