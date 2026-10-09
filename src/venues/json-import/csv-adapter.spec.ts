import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptCsv } from './csv-adapter';
import { area, bounds } from '../floor-plan/geometry';
import { countAreas } from '../floor/hall-floor';
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
  const fixture = (name: string) =>
    readFileSync(join(__dirname, `../../../test/fixtures/csv/${name}`), 'utf8');
  it('reads the existing ITPO export format and reports its template stalls', () => {
    const result = adaptCsv(fixture('existing-format-halls.csv'));
    expect(result.format).toBe('itpo');
    expect(result.missing).toEqual([]);
    expect(result.suggested).toMatchObject({ id: 'hall_id', width: 'length', depth: 'breadth' });
    expect(result.autoColumns.default_stalls).toMatch(/not imported/);
    expect(result.rows.map((r) => [r.sourceId, r.name, r.floor?.width, r.floor?.depth])).toEqual([
      ['11', 'Hall 11', 60, 40],
      ['12A', 'Hall 12A', 45, 30],
      ['14', 'Hall 14', 30, 20],
    ]);
    expect(result.rows[0].warnings).toContain(
      '2 template stall(s) were not imported: stalls come with the planner.',
    );
    expect(countAreas(result.rows[0].floor!)).toMatchObject({ column: 6, fire_curtain: 1 });
    expect(area(result.rows[1].floor!.geometry!.hallBoundary)).toBe(1270);
  });
  it('maps another system’s hall columns by their names and reads units from the headers', () => {
    const result = adaptCsv(fixture('external-format-halls.csv'));
    expect(result.format).toBe('generic');
    expect(result.missing).toEqual([]);
    expect(result.suggested).toEqual({
      id: 'Hall Ref',
      name: 'Hall Title',
      width: 'Length (m)',
      depth: 'Breadth (m)',
      zones: 'Foyer Zones',
      areas: 'Obstructions',
    });
    const [h11, h12a] = result.rows;
    expect([h11.error, h12a.error]).toEqual([null, null]);
    expect([h11.sourceId, h11.name, h11.floor!.width, h11.floor!.depth]).toEqual([
      '11',
      'Exhibition Hall 11',
      60,
      48,
    ]);
    expect(h11.warnings).toContain(
      'Units read from the column headers: m (Length (m), Breadth (m)).',
    );
    expect(bounds(h11.floor!.geometry!.zones[0].geometry)).toEqual({
      x: 20,
      y: 40,
      width: 20,
      height: 8,
    });
    expect(countAreas(h11.floor!)).toMatchObject({ column: 3, passage: 1 });
    // The foyer above Hall 12A moves the local origin; the hall keeps its size and place.
    expect(bounds(h12a.floor!.geometry!.hallBoundary)).toEqual({
      x: 0,
      y: 8,
      width: 45,
      height: 30,
    });
  });
  it('groups one row per space into halls and keeps every foyer where the file puts it', () => {
    const content = fixture('external-format-spaces.csv');
    const asHalls = adaptCsv(content);
    expect(asHalls.layoutHint).toBe('space');
    const result = adaptCsv(content, { rows: 'space' });
    expect(result.rowLayout).toBe('space');
    expect(result.missing).toEqual([]);
    expect(result.suggested).toMatchObject({
      id: 'Hall No.',
      name: 'Hall Name',
      kind: 'Space Type',
      x: 'X (m)',
      y: 'Y (m)',
      width: 'Length (m)',
      depth: 'Breadth (m)',
      label: 'Space Name',
    });
    expect(result.areaTypes).toEqual(expect.arrayContaining(['Hall Outline', 'Foyer', 'Stall']));
    const [h11, h12a] = result.rows;
    expect(result.rows.map((r) => [r.sourceId, r.name, r.records, r.error])).toEqual([
      ['11', 'Exhibition Hall 11', 14, null],
      ['12A', 'Hall 12A', 10, null],
    ]);
    expect(bounds(h11.floor!.geometry!.hallBoundary)).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 40,
    });
    expect(h11.floor!.geometry!.zones).toEqual([
      expect.objectContaining({ name: 'Foyer 11', kind: 'foyer', shared: false }),
    ]);
    expect(bounds(h11.floor!.geometry!.zones[0].geometry)).toEqual({
      x: 20,
      y: 40,
      width: 20,
      height: 8,
    });
    expect(countAreas(h11.floor!)).toMatchObject({ column: 6, passage: 1, entry: 1, utility: 1 });
    expect(h11.warnings).toContain(
      '3 stall row(s) were not imported: stalls come with the planner.',
    );
    // Venue coordinates: Hall 12A starts at x 80 and its foyer above it at y -8.
    expect(h12a.floor!.geometry!.source.origin).toEqual([80, -8]);
    expect(bounds(h12a.floor!.geometry!.zones[0].geometry)).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 8,
    });
    expect(bounds(h12a.floor!.geometry!.hallBoundary)).toEqual({
      x: 0,
      y: 8,
      width: 45,
      height: 30,
    });
  });
  it('validates space rows without guessing geometry', () => {
    const head = ['Hall', 'Type', 'X', 'Y', 'Width', 'Depth', 'Unit', 'Name'];
    const space = (rows: unknown[][], mapping = {}) =>
      adaptCsv(csv([head, ...rows]), { rows: 'space', ...mapping });
    // A required column that is absent leaves nothing to convert, but lists what is missing.
    const noType = adaptCsv('Hall,X,Y,Width,Depth\n11,0,0,10,10', { rows: 'space' });
    expect(noType.rows).toEqual([]);
    expect(noType.missing).toEqual(['kind', 'unit']);
    const result = space([
      ['A', 'Hall', 0, 0, 20, 10, 'm', 'A'],
      ['A', 'Pillar', 2, 2, 1, 1, 'm', 'P1'],
      ['A', 'Pillar', 2, 2, 1, 1, 'm', 'P1'],
      ['A', 'Stall', 5, 5, 3, 3, 'm', 'S1'],
      ['A', 'Stall', 5, 5, 3, 3, 'm', 'S1'],
      ['B', 'Pillar', 2, 2, 1, 1, 'm', 'P1'],
      ['C', 'Hall', 0, 0, 'ten', 10, 'm', ''],
      ['D', 'Hall', 0, 0, 20, 10, 'm', ''],
      ['D', 'Pillar', 2, 2, 1, 1, 'mm', ''],
      ['E', 'Hall', 0, 0, 20, -1, 'm', ''],
    ]);
    const [a, b, c, d, e] = result.rows;
    expect(a.error).toBeNull();
    expect(a.warnings).toEqual(
      expect.arrayContaining([
        '2 stall row(s) were not imported: stalls come with the planner.',
        '1 duplicate row(s) were skipped.',
      ]),
    );
    expect(countAreas(a.floor!).column).toBe(1);
    expect(b.error).toMatch(/No hall outline row.*never guessed/);
    expect(c.error).toBe('CSV row 8: Width must be a number.');
    expect(d.error).toMatch(/different units: m, mm/);
    expect(e.error).toBe('CSV row 11: width and depth must be greater than 0.');
    expect([b, c, d, e].every((r) => r.floor === null)).toBe(true);
    expect(() => space([['', 'Hall', 0, 0, 1, 1, 'm', '']])).toThrow(/row 2 has no hall/);
  });
  it('lets a manual mapping replace a suggestion, and an empty mapping ignore a column', () => {
    const content = csv([
      ['Hall No.', 'Name', 'Length', 'Breadth (m)', 'Height', 'foyers', 'Unit of measure'],
      ['H1', 'North', 20, 30, 6, JSON.stringify([{ x: 0, y: 30, width: 5, height: 3 }]), 'm'],
    ]);
    const automatic = adaptCsv(content);
    expect(automatic.suggested).toMatchObject({
      id: 'Hall No.',
      depth: 'Height',
      unitField: 'Unit of measure',
    });
    // Exact names win, in column order, as before: "Height" is read as the depth.
    expect(bounds(automatic.rows[0].floor!.geometry!.hallBoundary).height).toBe(6);
    const mapped = adaptCsv(content, { depth: 'Breadth (m)', zones: '' }).rows[0];
    expect(mapped.sourceId).toBe('H1');
    expect([mapped.floor!.width, mapped.floor!.depth]).toEqual([20, 30]);
    expect(mapped.floor!.geometry!.zones).toEqual([]);
    expect(() => adaptCsv(content, { rows: 'stalls' } as never)).toThrow();
  });
  it('warns when a foyer overlaps the hall or a space lies outside its hall', () => {
    const halls = adaptCsv(
      csv([
        ['id', 'width', 'depth', 'unit', 'foyers'],
        ['a', 20, 30, 'm', JSON.stringify([{ name: 'Lobby', x: 0, y: 28, width: 5, height: 4 }])],
      ]),
    );
    expect(halls.rows[0].warnings).toContain(
      'Lobby overlaps the hall floor by 10 m². A foyer lies beside the hall: check its position.',
    );
    const spaces = adaptCsv(
      csv([
        ['Hall', 'Type', 'X', 'Y', 'W', 'D', 'Label'],
        ['A', 'Hall', 0, 0, 20, 10, ''],
        ['A', 'Column', 50, 50, 1, 1, 'C9'],
      ]),
      { rows: 'space', unit: 'm', areaFields: { width: 'W', height: 'D' } },
    );
    expect(spaces.rows[0].warnings).toContain(
      '1 space(s) lie outside the hall and its foyers (C9). Check their hall column.',
    );
  });
});
