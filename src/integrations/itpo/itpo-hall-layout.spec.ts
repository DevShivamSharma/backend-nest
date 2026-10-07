import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blocksStalls, countAreas, floorArea, sameFloor } from '../../venues/floor/hall-floor';
import { parseCsv } from '../csv';
import { itpoRowToFloor, kindFromWords, readItpoHallRows } from './itpo-hall-layout';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../../test/fixtures/itpo', name), 'utf8');

/** A database export of the same row: JSON columns as text, quotes doubled, NULL for null. */
function asCsv(row: Record<string, unknown>): string {
  const columns = [
    'id',
    'hall_id',
    'layout_data',
    'status',
    'helper_text',
    'exit_labels',
    'direction',
    'legends',
    'length',
    'breadth',
    'default_stalls',
  ];
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return 'NULL';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const values: Record<string, unknown> = {
    id: 33,
    hall_id: row['hallId'],
    layout_data: row['layout_data'],
    status: 1,
    helper_text: row['helper_text'],
    exit_labels: row['exit_labels'],
    direction: row['direction'],
    legends: row['legends'],
    length: row['length'],
    breadth: row['breadth'],
    default_stalls: row['default_stalls'],
  };
  return `${columns.map((c) => `"${c}"`).join(',')}\n${columns.map((c) => cell(values[c])).join(',')}\n`;
}

describe('ITPO hall layouts', () => {
  const hall14ffJson = fixture('hall-14ff.json');
  const hall14ff = JSON.parse(hall14ffJson).data[0];

  it('reads SelfCare API responses with their name', () => {
    const [row] = readItpoHallRows(hall14ffJson, 'json');
    expect(row.hallId).toBe('62');
    expect(row.name).toBe('Hall 14FF');
  });

  it('turns every rectangle into a typed area, keeping the hidden fire curtains', () => {
    const [row] = readItpoHallRows(hall14ffJson, 'json');
    const { floor, warnings } = itpoRowToFloor(row);

    expect(floor.width).toBe(84);
    expect(floor.depth).toBe(116);
    expect(floor.areas).toHaveLength(203);
    expect(countAreas(floor)).toMatchObject({
      outside: 67,
      wall: 126,
      fire_curtain: 3,
      column: 5,
      passage: 2,
      marking: 0,
    });
    const curtains = floor.areas.filter((a) => a.kind === 'fire_curtain');
    expect(curtains.every((a) => a.hidden === true && blocksStalls(a.kind))).toBe(true);
    expect(floor.areas.find((a) => a.kind === 'column')?.label).toBe('Pillar');
    expect(warnings).toEqual([]);
  });

  it('converts labels, icons and the north arrow from pixels to metres', () => {
    const [row] = readItpoHallRows(hall14ffJson, 'json');
    const { floor } = itpoRowToFloor(row);

    expect(floor.labels).toHaveLength(hall14ff.exit_labels.length);
    expect(floor.labels[0]).toEqual({
      text: hall14ff.exit_labels[0].text,
      x: hall14ff.exit_labels[0].positionX / 20,
      y: hall14ff.exit_labels[0].positionY / 20,
    });
    expect(floor.iconGroups).toHaveLength(hall14ff.helper_text.length);
    expect(floor.iconGroups[0].icons.map((i) => i.kind)).toEqual(
      hall14ff.helper_text[0].image.map((i: { url: string }) =>
        i.url.split('/').pop()!.replace('.svg', ''),
      ),
    );
    expect(floor.north).toEqual({
      x: hall14ff.direction.positionX / 20,
      y: hall14ff.direction.positionY / 20,
      size: 5,
      rotation: hall14ff.direction.image.rotation,
      label: 'N',
    });
  });

  it('keeps the legend as plain text, with the meaning of each colour', () => {
    const [row] = readItpoHallRows(hall14ffJson, 'json');
    const { floor } = itpoRowToFloor(row);

    expect(floor.legend[0]).toMatchObject({
      color: '#8a2be2',
      kind: 'fire_curtain',
      showInView: false,
    });
    const coded = floor.legend.find((entry) => entry.code);
    expect(coded?.code).toMatch(/^[A-Z0-9-]+:$/);
    expect(JSON.stringify(floor.legend)).not.toContain('<');
  });

  it('reads the same row from a database CSV export identically', () => {
    const fromJson = itpoRowToFloor(readItpoHallRows(hall14ffJson, 'json')[0]).floor;
    const [csvRow] = readItpoHallRows(asCsv(hall14ff), 'csv');

    expect(csvRow.layoutId).toBe('33');
    expect(csvRow.name).toBeNull();
    expect(sameFloor(itpoRowToFloor(csvRow).floor, fromJson)).toBe(true);
  });

  it('measures the floor without the outside and the walls', () => {
    const [row] = readItpoHallRows(
      '"hall_id","length","breadth","layout_data"\n' +
        '"1","10","10","{""nonClickableAreas"": [' +
        '{""x"": 0, ""y"": 0, ""width"": 10, ""height"": 2, ""fillColor"": ""#ffffff""},' +
        '{""x"": 0, ""y"": 2, ""width"": 0.5, ""height"": 8, ""fillColor"": ""#742371""},' +
        '{""x"": 5, ""y"": 5, ""width"": 1, ""height"": 1, ""fillColor"": ""gray""}]}"\n',
      'csv',
    );
    // 100 m², less 20 m² outside and a 4 m² wall; a column is still floor.
    expect(floorArea(itpoRowToFloor(row).floor)).toBe(76);

    // Hall 14FF's curved outline leaves about 7,000 m² of its 84 x 116 m extent.
    const hall = floorArea(itpoRowToFloor(readItpoHallRows(hall14ffJson, 'json')[0]).floor);
    expect(hall).toBeGreaterThan(6500);
    expect(hall).toBeLessThan(7500);
  });

  it('types a colour from the hall legend, and keeps unknown colours as markings', () => {
    const row = {
      ...readItpoHallRows(fixture('hall-8-9-10.json'), 'json')[0],
      layoutData: {
        nonClickableAreas: [
          { x: 1, y: 1, width: 2, height: 1, fillColor: 'saddlebrown' },
          { x: 3, y: 1, width: 2, height: 1, fillColor: '#123456' },
          { x: 5, y: 1, width: 0, height: 1, fillColor: 'red' },
        ],
      },
    };
    const { floor, warnings } = itpoRowToFloor(row);

    expect(floor.areas.map((a) => a.kind)).toEqual(['no_build', 'marking']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('#123456');
  });

  it('refuses rows without a hall or a size', () => {
    expect(() => readItpoHallRows('"id","length"\n"1","10"\n', 'csv')).toThrow(/hall_id/);
    expect(() => readItpoHallRows('not json', 'json')).toThrow(/valid JSON/);
    const [row] = readItpoHallRows('"hall_id","length","breadth"\n"7","NULL","5"\n', 'csv');
    expect(() => itpoRowToFloor(row)).toThrow(/length and breadth/);
  });

  it('reads the words ITPO legends use', () => {
    expect(kindFromWords('Fire curtains (No construction zone below)')).toBe('fire_curtain');
    expect(kindFromWords('Compulsory passage for entry/exit/services')).toBe('passage');
    expect(kindFromWords('NC - No Construction Zone')).toBe('no_build');
    expect(kindFromWords('Area not available for exhibitions')).toBe('unavailable');
    expect(kindFromWords('Main entry/exit')).toBe('entry');
  });
});

describe('CSV', () => {
  it('keeps commas, quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('a,b\n"1,2","say ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['1,2', 'say "hi"\nthere'],
    ]);
  });

  it('refuses a file cut off inside a quote', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/quoted field/);
  });
});
