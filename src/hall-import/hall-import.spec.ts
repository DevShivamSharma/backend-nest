import { UnsupportedMediaTypeException } from '@nestjs/common';
import { validateHallGeometry } from '../layouts/placement/hall-geometry';
import { plainText } from './cad-drawing';
import { readDxf } from './dxf-reader';
import { analyseDrawing, classifyBlock, classifyLabel } from './hall-analysis';
import { detectFormat } from './hall-import.controller';
import { statedScale } from './pdf-drawing';
import { crossingStrips, enclosedAreas, traceOutlines } from './outline-trace';

/** Minimal ASCII DXF writer for tests: group-code pairs, one per line. */
class Dxf {
  private readonly lines: string[] = [];
  private pair(code: number, value: string | number): this {
    this.lines.push(String(code), String(value));
    return this;
  }
  header(insunits: number): this {
    return this.pair(0, 'SECTION').pair(2, 'HEADER').pair(9, '$ACADVER').pair(1, 'AC1032').pair(9, '$INSUNITS').pair(70, insunits).pair(0, 'ENDSEC');
  }
  layers(defs: Array<[string, number]>): this {
    this.pair(0, 'SECTION').pair(2, 'TABLES').pair(0, 'TABLE').pair(2, 'LAYER');
    for (const [name, color] of defs) this.pair(0, 'LAYER').pair(2, name).pair(70, 0).pair(62, color);
    return this.pair(0, 'ENDTAB').pair(0, 'ENDSEC');
  }
  blocks(fn: (d: Dxf) => void): this {
    this.pair(0, 'SECTION').pair(2, 'BLOCKS');
    fn(this);
    return this.pair(0, 'ENDSEC');
  }
  block(name: string, baseX: number, baseY: number, fn: (d: Dxf) => void): this {
    this.pair(0, 'BLOCK').pair(8, '0').pair(2, name).pair(70, 0).pair(10, baseX).pair(20, baseY);
    fn(this);
    return this.pair(0, 'ENDBLK');
  }
  entities(fn: (d: Dxf) => void): this {
    this.pair(0, 'SECTION').pair(2, 'ENTITIES');
    fn(this);
    return this.pair(0, 'ENDSEC');
  }
  line(layer: string, x1: number, y1: number, x2: number, y2: number): this {
    return this.pair(0, 'LINE').pair(8, layer).pair(10, x1).pair(20, y1).pair(11, x2).pair(21, y2);
  }
  rect(layer: string, x: number, y: number, w: number, h: number): this {
    return this.pair(0, 'LWPOLYLINE').pair(8, layer).pair(90, 4).pair(70, 1)
      .pair(10, x).pair(20, y).pair(10, x + w).pair(20, y).pair(10, x + w).pair(20, y + h).pair(10, x).pair(20, y + h);
  }
  solid(layer: string, x: number, y: number, size: number, color: number): this {
    return this.pair(0, 'SOLID').pair(8, layer).pair(62, color)
      .pair(10, x).pair(20, y).pair(11, x + size).pair(21, y).pair(12, x).pair(22, y + size).pair(13, x + size).pair(23, y + size);
  }
  text(layer: string, x: number, y: number, h: number, text: string): this {
    return this.pair(0, 'TEXT').pair(8, layer).pair(10, x).pair(20, y).pair(40, h).pair(1, text);
  }
  mtext(layer: string, x: number, y: number, h: number, text: string, attach = 5): this {
    return this.pair(0, 'MTEXT').pair(8, layer).pair(10, x).pair(20, y).pair(40, h).pair(71, attach).pair(1, text);
  }
  insert(layer: string, block: string, x: number, y: number, rotation = 0): this {
    return this.pair(0, 'INSERT').pair(8, layer).pair(2, block).pair(10, x).pair(20, y).pair(50, rotation);
  }
  build(): Uint8Array {
    return new Uint8Array(Buffer.from([...this.lines, '0', 'EOF'].join('\n') + '\n', 'utf8'));
  }
}

/**
 * A 60 x 40 m hall, walls as separate lines with a 6 m gate gap in the south wall, drawn in
 * metres with its lower-left corner at (1000, 2000).
 */
function sampleHall(): Uint8Array {
  const [X, Y] = [1000, 2000];
  return new Dxf()
    .header(6)
    .layers([['A-WALL', 7], ['SS-SMOKE CURTAIN', 6], ['AS-COLS', 8], ['A-ANNO-TEXT', 7], ['LEGEND', 7], ['OFF-LAYER', -7]])
    .blocks((d) =>
      d.block('XREF$0$LIFT CAR', 10, 10, (b) => b.rect('0', 10, 10, 2, 3)),
    )
    .entities((d) => {
      d.line('A-WALL', X, Y + 40, X + 60, Y + 40) // north
        .line('A-WALL', X + 60, Y, X + 60, Y + 40) // east
        .line('A-WALL', X, Y, X, Y + 40) // west
        .line('A-WALL', X, Y, X + 27, Y) // south, gate gap 27..33
        .line('A-WALL', X + 33, Y, X + 60, Y);
      d.mtext('A-ANNO-TEXT', X + 30, Y + 30, 1.5, 'EXHIBITION  HALL - 7\\PGROUND FLOOR')
        .text('A-ANNO-TEXT', X + 5, Y + 35, 0.5, 'TOILET(M)')
        .text('A-ANNO-TEXT', X + 12, Y + 35, 0.5, 'TOILET (FEMALE)')
        .mtext('A-ANNO-TEXT', X + 30, Y - 1.5, 0.8, '{\\fArial|b1;GATE 7C}')
        .text('A-ANNO-TEXT', X + 59, Y + 20, 0.5, 'EMERGENCY EXIT')
        .text('OFF-LAYER', X + 30, Y + 20, 0.5, 'LIFT'); // switched-off layer: ignored
      // A lift symbol, rotated 90° about an insertion point inside the hall.
      d.insert('A-ANNO-TEXT', 'XREF$0$LIFT CAR', X + 50, Y + 30, 90);
      d.line('SS-SMOKE CURTAIN', X + 1, Y + 20, X + 59, Y + 20);
      for (let i = 1; i < 6; i++) d.rect('AS-COLS', X + i * 10 - 0.5, Y + 10 - 0.5, 1, 1);
      // Legend, off to the side of the plan.
      d.text('LEGEND', X + 80, Y + 40, 1, 'LEGEND:')
        .solid('LEGEND', X + 80, Y + 37, 1, 1)
        .text('LEGEND', X + 83, Y + 37.5, 0.6, 'PASSAGE')
        .solid('LEGEND', X + 80, Y + 35, 1, 3)
        .text('LEGEND', X + 83, Y + 35.5, 0.6, 'TOILET FACILITIES');
    })
    .build();
}

describe('hall import: DXF reading', () => {
  it('reads units, text and expanded blocks, skipping switched-off layers', () => {
    const d = readDxf(sampleHall());
    expect(d.metresPerUnit).toBe(1);
    expect(d.texts.map((t) => t.text)).toContain('EXHIBITION HALL - 7 GROUND FLOOR');
    expect(d.texts.map((t) => t.text)).not.toContain('LIFT');
    const lift = d.inserts.find((i) => /LIFT CAR/.test(i.block))!;
    expect(lift).toMatchObject({ x: 1050, y: 2030 });
    // Block rect (10,10)-(12,13) around base (10,10), rotated 90° at (1050, 2030).
    const rect = d.polylines.find((p) => p.layer === 'A-ANNO-TEXT')!;
    const xs = rect.points.filter((_, i) => i % 2 === 0);
    const ys = rect.points.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(1047);
    expect(Math.max(...xs)).toBeCloseTo(1050);
    expect(Math.min(...ys)).toBeCloseTo(2030);
    expect(Math.max(...ys)).toBeCloseTo(2032);
  });

  it('rejects a binary DXF with a clear message', () => {
    const data = new Uint8Array(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00rest'));
    expect(() => readDxf(data)).toThrow(/ASCII DXF/);
  });
});

describe('hall import: analysis', () => {
  const result = analyseDrawing(readDxf(sampleHall()), 'hall-7.dxf');
  const hall = result.candidates[0];

  it('traces the outline from separate wall lines, gate gap included', () => {
    expect(result.scale).toMatchObject({ metresPerUnit: 1, known: true });
    expect(hall.name).toBe('Hall 7 GF');
    expect(hall.width).toBeGreaterThan(59);
    expect(hall.width).toBeLessThan(61);
    expect(hall.length).toBeGreaterThan(39);
    expect(hall.length).toBeLessThan(41);
    expect(hall.areaM2).toBeGreaterThan(2300);
    expect(hall.areaM2).toBeLessThan(2500);
  });

  it('recognises toilets, lifts, gates and exits where the plan puts them', () => {
    const byKind = (kind: string) => hall.amenities.filter((a) => a.kind === kind);
    expect(byKind('toilet-male')).toHaveLength(1);
    expect(byKind('toilet-female')).toHaveLength(1);
    expect(byKind('lift')).toHaveLength(1);
    expect(byKind('lift')[0].source).toBe('symbol');
    const gate = byKind('entry-up')[0];
    expect(gate.label).toBe('Gate 7C');
    // Plan coordinates: centre-origin, Z down. The gate is on the south wall: +Z.
    expect(gate.position.x).toBeCloseTo(0, 0);
    expect(gate.position.z).toBeGreaterThan(19);
    expect(byKind('emergency-exit')).toHaveLength(1);
  });

  it('turns wall-side gates and exits into openings facing into the hall', () => {
    const gate = hall.openings.find((o) => o.kind === 'ENTRY')!;
    expect(gate).toMatchObject({ label: 'Gate 7C', facing: 'NORTH' });
    expect(hall.openings.find((o) => o.kind === 'EMERGENCY')).toMatchObject({ facing: 'WEST' });
  });

  it('finds smoke curtains, pillars and the legend with its colours', () => {
    expect(hall.zones).toHaveLength(1);
    expect(hall.zones[0].kind).toBe('SMOKE_CURTAIN');
    expect(hall.blockedAreas).toHaveLength(5);
    expect(hall.blockedAreas[0]).toMatchObject({ kind: 'zone', title: 'Pillar', width: 1, length: 1 });
    expect(hall.legends).toEqual([
      { label: 'PASSAGE', colorCode: '#ff0000', visibleInViewMode: true, visibleInBookMode: true },
      { label: 'TOILET FACILITIES', colorCode: '#00ff00', visibleInViewMode: true, visibleInBookMode: true },
    ]);
  });

  it('returns the whole plan and its closed areas, in one frame with the hall', () => {
    const overview = result.overview;
    expect(overview.origin).toEqual({ x: 0, z: 0 });
    // Every facility of the hall is in the overview at hall position + origin.
    for (const a of hall.amenities) {
      const x = a.position.x + hall.origin.x;
      const z = a.position.z + hall.origin.z;
      expect(overview.amenities.some((o) => o.kind === a.kind && Math.hypot(o.position.x - x, o.position.z - z) < 0.01)).toBe(true);
    }
    expect(result.rooms.length).toBeGreaterThan(0);
    expect(result.rooms[0].areaM2).toBeGreaterThan(2000);
  });

  it('produces a hall the planner accepts as it is', () => {
    expect(() =>
      validateHallGeometry({
        boundary: hall.boundary,
        zones: hall.zones,
        openings: hall.openings,
        markers: hall.markers,
        amenities: hall.amenities,
        legends: hall.legends,
        blockedAreas: hall.blockedAreas,
      }),
    ).not.toThrow();
  });
});

describe('hall import: helpers', () => {
  it.each([
    ['TOILET(F)', 'toilet-female'],
    ['TOILET (FEMALE)', 'toilet-female'],
    ['TOILET(MALE)', 'toilet-male'],
    ['GENTS TOILET', 'toilet-male'],
    ['HANDICAPPED TOILET 2075X2200', 'toilet'],
    ['TOILET 5G-A', 'toilet'],
    ['LIFT 1950x2000', 'lift'],
    ['GLASS ELEVATORS', 'lift'],
    ['CARGO LIFT4900X7120', 'lift'],
    ['CARGO/SERVICE ENTRY', 'cargo-truck'],
    ['DRINKING WATER (12 NOs.)', 'drinking-water'],
    ['EMERGENCY EXIT', 'emergency-exit'],
    ['GATE 5C', 'entry-up'],
    ['STAIRCASE', 'stairs'],
  ])('%s -> %s', (text, kind) => {
    expect(classifyLabel(text)?.kind).toBe(kind);
  });

  it('keeps the plan name of a named toilet block', () => {
    expect(classifyLabel('TOILET 5G-A')?.label).toBe('Toilet 5G-A');
  });

  it.each([['FOYER 5G'], ['ROLLING SHUTTER'], ['12m²'], ['FIRE CONTROL ROOM']])('ignores %s', (text) => {
    expect(classifyLabel(text)).toBeNull();
  });

  it('recognises symbols by the block name, not the xref it came from', () => {
    expect(classifyBlock('XA_A3_A5_COL$0$Ex_hall$0$LIFT CAR')?.kind).toBe('lift');
    expect(classifyBlock('Ex_hall_A6_PLANS_8STAIRCASE$0$wash-basin')).toBeNull();
  });

  it('cleans MTEXT formatting', () => {
    expect(plainText('\\pxql;{\\fArial|b1;FROM GATE-10}\\PHALL 7')).toBe('FROM GATE-10 HALL 7');
    expect(plainText('%%ULEGEND:')).toBe('LEGEND:');
    expect(plainText('LIFT \\P1950x2000')).toBe('LIFT 1950x2000');
  });

  it('names a hall from ITPO drawing file names when the plan does not say', () => {
    const empty = { format: 'pdf' as const, metresPerUnit: null, scaleSource: '', polylines: [], texts: [], inserts: [], fills: [], layers: [], warnings: [] };
    const named = (file: string) => analyseDrawing(empty, file).candidates[0].name;
    expect(named('IIFF_2026_30JULY2026_H5G_Layout.pdf')).toBe('Hall 5 GF');
    expect(named('H4F plan.pdf')).toBe('Hall 4 FF');
    expect(named('site plan.pdf')).toBe('site plan');
  });

  it('reads a stated plan scale', () => {
    expect(statedScale(['SCALE 1:200', 'HALL 5'])).toBe(200);
    expect(statedScale(['HALL 5'])).toBeNull();
  });

  it('detects the format by content and turns DWG away with guidance', () => {
    expect(detectFormat(Buffer.from('%PDF-1.7\n'), 'plan.pdf')).toBe('pdf');
    expect(detectFormat(Buffer.from('  0\r\nSECTION\r\n'), 'plan.dxf')).toBe('dxf');
    expect(() => detectFormat(Buffer.from('AC1032\x00\x00'), 'plan.dwg')).toThrow(UnsupportedMediaTypeException);
    expect(() => detectFormat(Buffer.from('hello'), 'notes.txt')).toThrow(/DXF or a PDF/);
  });
});

describe('hall import: multi-hall helpers', () => {
  // Two 40 x 30 m floors side by side, each ringed by a painted band, 1 unit = 1 m.
  const ring = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y, x + w, y + h, x + w, y + h, x, y + h, x, y + h, x, y];
  const bands: number[] = [];
  for (let k = 0; k < 3; k++) bands.push(...ring(k, k, 40 - 2 * k, 30 - 2 * k), ...ring(45 + k, k, 40 - 2 * k, 30 - 2 * k));
  const box = { minX: -2, minY: -2, maxX: 88, maxY: 32 };

  it('finds each floor a painted band encloses, band included', () => {
    const floors = enclosedAreas(bands, box, 1, { closeMetres: 1.5, minArea: 100, withBandMetres: 4 });
    expect(floors).toHaveLength(2);
    for (const f of floors) {
      expect(f.box.maxX - f.box.minX).toBeGreaterThan(38);
      expect(f.box.maxX - f.box.minX).toBeLessThan(42);
    }
  });

  it('finds partition strips that cross a floor, even joined by cross lines', () => {
    const lines = [
      ...[20, 20.4, 20.8].flatMap((x) => [x, 0, x, 30]), // a 0.8 m partition at x = 20.4
      0, 15, 40, 15, // a cross line joining everything
    ];
    const strips = crossingStrips(lines, { minX: 0, minY: 0, maxX: 40, maxY: 30 }, 1, { alongX: true, minCover: 0.6, maxWidthMetres: 3 });
    expect(strips).toHaveLength(1);
    expect(strips[0]).toBeCloseTo(20.4, 0);
  });

  it('never cuts a known exhibition floor out of a traced outline (Hall 6 rolling shutter)', () => {
    // A 120 x 80 m hall, 1 unit = 1 m. Its top wall has a 16 m opening with no line across it
    // (a rolling shutter), wider than the tracer closes. Smoke curtains box in the bay behind it.
    const walls = [
      { layer: 'A-WALL', color: null, closed: false, points: [52, 80, 0, 80, 0, 0, 120, 0, 120, 80, 68, 80] },
      { layer: 'SS-SMOKE CURTAIN', color: null, closed: false, points: [40, 79, 40, 40, 80, 40, 80, 79] },
    ];
    const areaOf = (interior: number[][]) => traceOutlines(walls, 1, () => true, interior)[0]?.area ?? 0;
    // Without the floor, the outside floods through the opening and the bay is lost.
    expect(areaOf([])).toBeLessThan(0.85 * 9600);
    // The exhibition floor (inside its peripheral passage) is known interior: the hall is whole.
    const floor = [2, 2, 118, 2, 118, 78, 2, 78];
    expect(areaOf([floor])).toBeGreaterThan(0.97 * 9600);
  });
});
