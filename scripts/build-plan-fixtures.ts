/**
 * Builds the synthetic plan fixtures for `npm run eval:plans`: plans drawn from a known scene,
 * so the truth (each hall's floor, bands, foyer, scale) is exact by construction, not read back
 * from the importer. Each scene renders to the format its case needs: a raster (PNG or a noisy
 * JPEG, as a scan), a vector PDF, or a DXF.
 *
 *   npx ts-node --transpile-only scripts/build-plan-fixtures.ts
 *
 * Writes test/fixtures/plans/synthetic/<case>.<ext> and <case>.truth.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

const OUT = join(__dirname, '../test/fixtures/plans/synthetic');

type Rect = { x: number; y: number; w: number; h: number };
type Prim =
  | { t: 'rect'; r: Rect; fill: string; hatch?: string }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { t: 'text'; x: number; y: number; size: number; text: string; color?: string; vertical?: boolean };

interface TruthHall {
  name: string;
  page: number;
  /** The hall's own floor (gridded, plus bands lying on it), sheet metres. */
  floor: Rect[];
  /** Areas on the floor that block stalls, with their kind, sheet metres. */
  bands: Array<{ kind: string; color: string; rect: Rect }>;
  voids: Rect[];
  foyer: Rect[];
  /** Printed width and depth of the hall (dimension lines), metres. */
  printed?: { width?: number; depth?: number };
}

interface Truth {
  case: string;
  file: string;
  /** How the truth was made. */
  source: string;
  sheet: { width: number; height: number };
  gridMetres: number | null;
  halls: TruthHall[];
  /** A foyer between halls the plan does not assign. */
  sharedFoyer?: Rect[];
  /** What each colour on the floor means, per the plan's legend. */
  legend: Record<string, string>;
  expect: Record<string, unknown>;
}

const GRID_LINE = '#b4b4b4';
const INK = '#202020';

// ---- scene helpers ------------------------------------------------------------------------

function grid(r: Rect, cell: number, phase = { x: 0, y: 0 }): Prim[] {
  const out: Prim[] = [];
  const start = (v: number, p: number) => p + Math.ceil((v - p) / cell - 1e-9) * cell;
  for (let x = start(r.x, phase.x); x <= r.x + r.w + 1e-9; x += cell) {
    out.push({ t: 'line', x1: x, y1: r.y, x2: x, y2: r.y + r.h, color: GRID_LINE, width: 0 });
  }
  for (let y = start(r.y, phase.y); y <= r.y + r.h + 1e-9; y += cell) {
    out.push({ t: 'line', x1: r.x, y1: y, x2: r.x + r.w, y2: y, color: GRID_LINE, width: 0 });
  }
  return out;
}

/** A wall drawn as a dark band just outside a rectangle. */
function walls(r: Rect, t = 0.4, gaps: Rect[] = []): Prim[] {
  const sides: Rect[] = [
    { x: r.x - t, y: r.y - t, w: r.w + 2 * t, h: t },
    { x: r.x - t, y: r.y + r.h, w: r.w + 2 * t, h: t },
    { x: r.x - t, y: r.y, w: t, h: r.h },
    { x: r.x + r.w, y: r.y, w: t, h: r.h },
  ];
  return sides.flatMap((s) => splitAround(s, gaps)).map((s) => ({ t: 'rect' as const, r: s, fill: INK }));
}

function splitAround(r: Rect, gaps: Rect[]): Rect[] {
  let pieces = [r];
  for (const g of gaps) {
    pieces = pieces.flatMap((p) => {
      const ix = Math.max(p.x, g.x);
      const iy = Math.max(p.y, g.y);
      const ax = Math.min(p.x + p.w, g.x + g.w);
      const ay = Math.min(p.y + p.h, g.y + g.h);
      if (ax <= ix || ay <= iy) return [p];
      const out: Rect[] = [];
      if (iy > p.y) out.push({ x: p.x, y: p.y, w: p.w, h: iy - p.y });
      if (ay < p.y + p.h) out.push({ x: p.x, y: ay, w: p.w, h: p.y + p.h - ay });
      if (ix > p.x) out.push({ x: p.x, y: iy, w: ix - p.x, h: ay - iy });
      if (ax < p.x + p.w) out.push({ x: ax, y: iy, w: p.x + p.w - ax, h: ay - iy });
      return out;
    });
  }
  return pieces.filter((p) => p.w > 1e-6 && p.h > 1e-6);
}

/** A dimension line with tick marks and extension lines, its value printed above it. */
function dimension(x1: number, y1: number, x2: number, y2: number, text: string, size = 1.2): Prim[] {
  const vertical = x1 === x2;
  const out: Prim[] = [{ t: 'line', x1, y1, x2, y2, color: INK, width: 0.08 }];
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ]) {
    // Extension line across the dimension line, and a slanted tick.
    if (vertical) out.push({ t: 'line', x1: x - 1, y1: y, x2: x + 1, y2: y, color: INK, width: 0.08 });
    else out.push({ t: 'line', x1: x, y1: y - 1, x2: x, y2: y + 1, color: INK, width: 0.08 });
    out.push({ t: 'line', x1: x - 0.5, y1: y + 0.5, x2: x + 0.5, y2: y - 0.5, color: INK, width: 0.12 });
  }
  if (vertical) {
    out.push({ t: 'text', x: x1 - 0.4 - size, y: (y1 + y2) / 2, size, text, vertical: true });
  } else {
    out.push({ t: 'text', x: (x1 + x2) / 2 - (0.3 * size * text.length), y: y1 - 0.6, size, text });
  }
  return out;
}

function legend(x: number, y: number, rows: Array<[string, string]>): Prim[] {
  const out: Prim[] = [{ t: 'text', x, y, size: 1.4, text: 'LEGEND:' }];
  rows.forEach(([color, text], i) => {
    const ry = y + 2.6 + i * 2.4;
    out.push({ t: 'rect', r: { x, y: ry - 1.2, w: 3, h: 1.4 }, fill: color });
    out.push({ t: 'text', x: x + 3.8, y: ry, size: 1.1, text });
  });
  return out;
}

// ---- renderers ----------------------------------------------------------------------------

function svg(prims: Prim[], sheet: { width: number; height: number }, ppm: number): string {
  const px = (v: number) => (v * ppm).toFixed(2);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(sheet.width * ppm)}" height="${Math.round(sheet.height * ppm)}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  for (const p of prims) {
    if (p.t === 'rect') {
      parts.push(`<rect x="${px(p.r.x)}" y="${px(p.r.y)}" width="${px(p.r.w)}" height="${px(p.r.h)}" fill="${p.fill}"/>`);
    } else if (p.t === 'line') {
      const w = Math.max(1, p.width * ppm);
      // Thin lines on whole pixels, as a plotter prints them.
      const snap = (v: number) => (w <= 1 ? Math.floor(v * ppm) + 0.5 : v * ppm).toFixed(2);
      parts.push(`<line x1="${snap(p.x1)}" y1="${snap(p.y1)}" x2="${snap(p.x2)}" y2="${snap(p.y2)}" stroke="${p.color}" stroke-width="${w.toFixed(2)}" shape-rendering="crispEdges"/>`);
    } else {
      const size = p.size * ppm;
      const attrs = `font-family="DejaVu Sans, Arial, sans-serif" font-size="${size.toFixed(1)}" fill="${p.color ?? INK}"`;
      const esc = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      parts.push(
        p.vertical
          ? `<text x="${px(p.x + p.size)}" y="${px(p.y)}" ${attrs} text-anchor="middle" transform="rotate(-90 ${px(p.x + p.size)} ${px(p.y)})">${esc}</text>`
          : `<text x="${px(p.x)}" y="${px(p.y)}" ${attrs}>${esc}</text>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

async function raster(
  prims: Prim[],
  sheet: { width: number; height: number },
  ppm: number,
  file: string,
  options: { rotate?: number; jpegQuality?: number; noise?: number } = {},
): Promise<void> {
  let img = sharp(Buffer.from(svg(prims, sheet, ppm)));
  if (options.rotate) img = sharp(await img.png().toBuffer()).rotate(options.rotate, { background: '#ffffff' });
  if (options.noise) {
    const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let seed = 7;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = Math.max(0, Math.min(255, data[i] + ((seed % (2 * options.noise + 1)) - options.noise)));
    }
    img = sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } });
  }
  const out = options.jpegQuality ? img.jpeg({ quality: options.jpegQuality }) : img.png();
  await out.toFile(join(OUT, file));
}

/** A minimal PDF: one page per scene, lines, filled rectangles and Helvetica text. */
function pdf(pages: Array<{ prims: Prim[]; sheet: { width: number; height: number } }>, ptPerM: number): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const kids: number[] = [];
  const pagesId = objects.length + 1 + pages.length * 2;
  for (const page of pages) {
    const H = page.sheet.height * ptPerM;
    const rgb = (hex: string) =>
      [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
    const ops: string[] = [];
    for (const p of page.prims) {
      if (p.t === 'rect') {
        ops.push(`${rgb(p.fill)} rg ${(p.r.x * ptPerM).toFixed(2)} ${(H - (p.r.y + p.r.h) * ptPerM).toFixed(2)} ${(p.r.w * ptPerM).toFixed(2)} ${(p.r.h * ptPerM).toFixed(2)} re f`);
      } else if (p.t === 'line') {
        ops.push(`${rgb(p.color)} RG ${Math.max(0.1, p.width * ptPerM).toFixed(2)} w ${(p.x1 * ptPerM).toFixed(2)} ${(H - p.y1 * ptPerM).toFixed(2)} m ${(p.x2 * ptPerM).toFixed(2)} ${(H - p.y2 * ptPerM).toFixed(2)} l S`);
      } else {
        const esc = p.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        const size = p.size * ptPerM;
        const m = p.vertical
          ? `0 1 -1 0 ${((p.x + p.size) * ptPerM).toFixed(2)} ${(H - p.y * ptPerM).toFixed(2)}`
          : `1 0 0 1 ${(p.x * ptPerM).toFixed(2)} ${(H - p.y * ptPerM).toFixed(2)}`;
        ops.push(`BT ${rgb(p.color ?? INK)} rg /F1 ${size.toFixed(2)} Tf ${m} Tm (${esc}) Tj ET`);
      }
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${(page.sheet.width * ptPerM).toFixed(2)} ${H.toFixed(2)}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
    kids.push(pageId);
  }
  const pagesObj = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  if (pagesObj !== pagesId) throw new Error('PDF object numbering');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A minimal DXF (R2000-style ENTITIES), y up, in `unitsPerM` units per metre. */
function dxf(prims: Prim[], sheet: { width: number; height: number }, unitsPerM: number, insunits: number): string {
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(insunits), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const X = (v: number) => (v * unitsPerM).toFixed(3);
  const Y = (v: number) => ((sheet.height - v) * unitsPerM).toFixed(3);
  const color = (hex: string) => String(parseInt(hex.slice(1), 16));
  for (const p of prims) {
    if (p.t === 'line') {
      out.push('0', 'LINE', '8', 'PLAN', '420', color(p.color), '10', X(p.x1), '20', Y(p.y1), '11', X(p.x2), '21', Y(p.y2));
    } else if (p.t === 'rect') {
      const { x, y, w, h } = p.r;
      out.push('0', 'SOLID', '8', 'FILL', '420', color(p.fill),
        '10', X(x), '20', Y(y), '11', X(x + w), '21', Y(y), '12', X(x), '22', Y(y + h), '13', X(x + w), '23', Y(y + h));
    } else {
      out.push('0', 'TEXT', '8', 'TEXT', '10', X(p.x), '20', Y(p.y), '40', (p.size * unitsPerM).toFixed(3), '1', p.text, ...(p.vertical ? ['50', '90'] : []));
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

// ---- scenes -------------------------------------------------------------------------------

const RED = '#e04848';
const PURPLE = '#8a2be2';
const ORANGE = '#c8873c';
const GREY = '#8c8c8c';

/** One hall: a gridded rectangle with passages, a fire curtain straddling grid lines, columns. */
function singleHall(origin = { x: 10, y: 14 }, size = { w: 60, h: 40 }, name = 'HALL A', cell = 1) {
  const hall: Rect = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  const curtain: Rect = { x: hall.x + 29.5, y: hall.y, w: 1, h: hall.h }; // 1 m wide, between grid lines
  const passages: Rect[] = [
    { x: hall.x, y: hall.y, w: 6, h: 3 },
    { x: hall.x + hall.w - 6, y: hall.y + hall.h - 3, w: 6, h: 3 },
  ];
  const columns: Rect[] = [
    { x: hall.x + 15, y: hall.y + 20, w: 1.2, h: 1.2 },
    { x: hall.x + 45, y: hall.y + 20, w: 1.2, h: 1.2 },
  ];
  const prims: Prim[] = [
    ...grid(hall, cell, origin),
    ...passages.map((r) => ({ t: 'rect' as const, r, fill: RED })),
    { t: 'rect', r: curtain, fill: PURPLE },
    ...columns.map((r) => ({ t: 'rect' as const, r, fill: GREY })),
    ...walls(hall),
    { t: 'text', x: hall.x + 2, y: hall.y - 2, size: 2.4, text: name },
    ...dimension(hall.x, hall.y - 6, hall.x + hall.w, hall.y - 6, `${hall.w.toFixed(2)}`),
    ...dimension(hall.x - 6, hall.y, hall.x - 6, hall.y + hall.h, `${hall.h.toFixed(2)}`),
  ];
  const truth: TruthHall = {
    name: titleCase(name),
    page: 1,
    floor: [hall],
    bands: [
      ...passages.map((rect) => ({ kind: 'passage', color: RED, rect })),
      { kind: 'fire_curtain', color: PURPLE, rect: curtain },
    ],
    voids: [],
    foyer: [],
    printed: { width: hall.w, depth: hall.h },
  };
  return { prims, truth, hall };
}

const LEGEND_ROWS: Array<[string, string]> = [
  [RED, 'COMPULSORY PASSAGE FOR EXITS / SERVICES'],
  [PURPLE, '1M WIDE NO CONSTRUCTION ZONE BELOW FIRE CURTAINS'],
  [GREY, 'COLUMNS'],
];
const LEGEND_KINDS = { [RED]: 'passage', [PURPLE]: 'fire_curtain', [GREY]: 'column' };

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .replace(/\b([a-z])$/i, (c) => c.toUpperCase());
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const truths: Truth[] = [];
  const write = (t: Truth) => {
    writeFileSync(join(OUT, `${t.case}.truth.json`), `${JSON.stringify(t, null, 2)}\n`);
    truths.push(t);
  };

  // 1. One hall on a scan at 10 px/m.
  {
    const sheet = { width: 120, height: 75 };
    const s = singleHall();
    const prims = [
      ...s.prims,
      ...legend(80, 14, LEGEND_ROWS),
      { t: 'text' as const, x: 80, y: 30, size: 1.2, text: 'NOTE: GRID SIZE IS 1M X 1M' },
    ];
    await raster(prims, sheet, 10, 'single-hall.png');
    write({
      case: 'single-hall',
      file: 'single-hall.png',
      source: 'Synthetic scene (scripts/build-plan-fixtures.ts): truth is the drawn geometry.',
      sheet,
      gridMetres: 1,
      halls: [s.truth],
      legend: LEGEND_KINDS,
      expect: { scaleStatus: ['verified', 'single'], halls: 1 },
    });
  }

  // 2. Two halls with a foyer between them that the plan does not assign.
  {
    const sheet = { width: 180, height: 90 };
    const b = singleHall({ x: 8, y: 12 }, { w: 50, h: 40 }, 'HALL B');
    const c = singleHall({ x: 66, y: 12 }, { w: 50, h: 40 }, 'HALL C');
    const foyer: Rect = { x: 30, y: 58, w: 64, h: 14 };
    const prims: Prim[] = [
      ...b.prims,
      ...c.prims,
      ...grid(foyer, 1, { x: 0, y: 0 }),
      ...walls(foyer),
      { t: 'text', x: 55, y: 66, size: 1.6, text: 'FOYER' },
      ...legend(122, 12, LEGEND_ROWS),
      { t: 'text', x: 122, y: 26, size: 1.1, text: 'NOTE: GRID SIZE IS 1M X 1M' },
    ];
    await raster(prims, sheet, 10, 'two-halls-shared-foyer.png');
    write({
      case: 'two-halls-shared-foyer',
      file: 'two-halls-shared-foyer.png',
      source: 'Synthetic scene: two titled halls, one untitled foyer touching neither by grid.',
      sheet,
      gridMetres: 1,
      halls: [b.truth, c.truth],
      sharedFoyer: [foyer],
      legend: LEGEND_KINDS,
      expect: { halls: 2, sharedFoyerUndecided: true },
    });
  }

  // 3. Two titled halls on one continuous grid: the plan draws no boundary between them.
  {
    const sheet = { width: 130, height: 70 };
    const floor: Rect = { x: 10, y: 12, w: 80, h: 40 };
    const prims: Prim[] = [
      ...grid(floor, 1, { x: 10, y: 12 }),
      ...walls(floor),
      { t: 'text', x: 25, y: 30, size: 2.4, text: 'HALL D' },
      { t: 'text', x: 65, y: 30, size: 2.4, text: 'HALL E' },
      { t: 'text', x: 96, y: 14, size: 1.1, text: 'NOTE: GRID SIZE IS 1M X 1M' },
    ];
    await raster(prims, sheet, 10, 'connected-halls.png');
    write({
      case: 'connected-halls',
      file: 'connected-halls.png',
      source: 'Synthetic scene: one floor carrying two hall titles; split at x = 50 m by the reviewer.',
      sheet,
      gridMetres: 1,
      halls: [
        { name: 'Hall D', page: 1, floor: [{ x: 10, y: 12, w: 40, h: 40 }], bands: [], voids: [], foyer: [] },
        { name: 'Hall E', page: 1, floor: [{ x: 50, y: 12, w: 40, h: 40 }], bands: [], voids: [], foyer: [] },
      ],
      legend: {},
      expect: { separationIssue: true, cutAtX: 50 },
    });
  }

  // 4. An L-shaped hall on a 2 m grid with a void, as a vector PDF.
  {
    const sheet = { width: 140, height: 100 };
    const a: Rect = { x: 10, y: 14, w: 80, h: 30 };
    const b2: Rect = { x: 10, y: 44, w: 30, h: 40 };
    const lift: Rect = { x: 50, y: 24, w: 6, h: 6 };
    const curtain: Rect = { x: 10, y: 33, w: 80, h: 1 };
    const prims: Prim[] = [
      ...grid(a, 2, { x: 10, y: 14 }).filter((p) => !(p.t === 'line' && insideStrict(p, lift))),
      ...grid(b2, 2, { x: 10, y: 14 }),
      { t: 'rect', r: curtain, fill: PURPLE },
      ...walls(lift, 0.3),
      { t: 'text', x: 51, y: 27.5, size: 1.4, text: 'LIFT' },
      { t: 'text', x: 14, y: 12, size: 2.4, text: 'PAVILION 2' },
      ...dimension(a.x, a.y - 5, a.x + a.w, a.y - 5, '80.00'),
      ...dimension(a.x - 5, a.y, a.x - 5, b2.y + b2.h, '70.00'),
      ...legend(100, 14, [[PURPLE, 'FIRE CURTAIN - NO CONSTRUCTION BELOW']]),
      { t: 'text', x: 100, y: 22, size: 1.1, text: 'GRID SIZE 2M X 2M' },
    ];
    writeFileSync(join(OUT, 'irregular-grid2m.pdf'), pdf([{ prims, sheet }], 12));
    write({
      case: 'irregular-grid2m',
      file: 'irregular-grid2m.pdf',
      source: 'Synthetic scene: L-shaped floor on a 2 m grid, a lift void, a 1 m curtain off the grid lines.',
      sheet,
      gridMetres: 2,
      halls: [
        {
          name: 'Pavilion 2',
          page: 1,
          floor: [a, b2],
          bands: [{ kind: 'fire_curtain', color: PURPLE, rect: curtain }],
          voids: [lift],
          foyer: [],
          printed: { width: 80, depth: 70 },
        },
      ],
      legend: { [PURPLE]: 'fire_curtain' },
      expect: { halls: 1, scaleStatus: ['verified'] },
    });
  }

  // 5. A DXF in millimetres with a 3 m grid and no printed grid size.
  {
    const sheet = { width: 110, height: 80 };
    const hall: Rect = { x: 10, y: 12, w: 45, h: 36 };
    const prims: Prim[] = [
      ...grid(hall, 3, { x: 10, y: 12 }),
      ...walls(hall),
      { t: 'text', x: 12, y: 10, size: 2.4, text: 'HALLE 3' },
      ...dimension(hall.x, hall.y - 5, hall.x + hall.w, hall.y - 5, '45000'),
      ...dimension(hall.x - 5, hall.y, hall.x - 5, hall.y + hall.h, '36000'),
    ];
    writeFileSync(join(OUT, 'mm-grid3m.dxf'), dxf(prims, sheet, 1000, 4));
    write({
      case: 'mm-grid3m',
      file: 'mm-grid3m.dxf',
      source: 'Synthetic scene: DXF in millimetres ($INSUNITS 4), 3 m grid, dimensions in mm.',
      sheet,
      gridMetres: 3,
      halls: [{ name: 'Halle 3', page: 1, floor: [hall], bands: [], voids: [], foyer: [], printed: { width: 45, depth: 36 } }],
      legend: {},
      expect: { halls: 1, scaleStatus: ['verified', 'single'] },
    });
  }

  // 6. The single hall, scanned 4 degrees turned.
  {
    const sheet = { width: 120, height: 75 };
    const s = singleHall();
    const prims = [...s.prims, ...legend(80, 14, LEGEND_ROWS), { t: 'text' as const, x: 80, y: 30, size: 1.2, text: 'NOTE: GRID SIZE IS 1M X 1M' }];
    await raster(prims, sheet, 10, 'rotated-4deg.png', { rotate: 4 });
    write({
      case: 'rotated-4deg',
      file: 'rotated-4deg.png',
      source: 'Synthetic scene: single-hall turned 4° clockwise before scanning.',
      sheet,
      gridMetres: 1,
      halls: [s.truth],
      legend: LEGEND_KINDS,
      expect: { halls: 1, rotation: 4 },
    });
  }

  // 7. No grid: walls and dimension lines only.
  {
    const sheet = { width: 100, height: 70 };
    const hall: Rect = { x: 12, y: 14, w: 50, h: 30 };
    const prims: Prim[] = [
      ...walls(hall, 0.5),
      { t: 'text', x: 30, y: 30, size: 2.4, text: 'HALL G' },
      ...dimension(hall.x, hall.y - 6, hall.x + hall.w, hall.y - 6, '50.00'),
      ...dimension(hall.x - 6, hall.y, hall.x - 6, hall.y + hall.h, '30.00'),
    ];
    await raster(prims, sheet, 10, 'no-grid.png');
    write({
      case: 'no-grid',
      file: 'no-grid.png',
      source: 'Synthetic scene: a walled hall without a stall grid; scale only from dimension lines.',
      sheet,
      gridMetres: null,
      halls: [{ name: 'Hall G', page: 1, floor: [hall], bands: [], voids: [], foyer: [], printed: { width: 50, depth: 30 } }],
      legend: {},
      expect: { halls: 1, mapSource: 'outline', boundaryCheck: 'unknown' },
    });
  }

  // 8. The same red, meaning different things on two plans.
  for (const [suffix, text, kind] of [
    ['a', 'COMPULSORY PASSAGE', 'passage'],
    ['b', 'NO CONSTRUCTION ZONE', 'no_build'],
  ] as const) {
    const sheet = { width: 120, height: 75 };
    const s = singleHall();
    const prims = [
      ...s.prims.filter((p) => !(p.t === 'rect' && p.fill === PURPLE)),
      ...legend(80, 14, [[RED, text]]),
      { t: 'text' as const, x: 80, y: 22, size: 1.2, text: 'NOTE: GRID SIZE IS 1M X 1M' },
    ];
    await raster(prims, sheet, 10, `legend-${suffix}.png`);
    write({
      case: `legend-${suffix}`,
      file: `legend-${suffix}.png`,
      source: `Synthetic scene: red drawn on the floor; the legend says it is "${text}".`,
      sheet,
      gridMetres: 1,
      halls: [{ ...s.truth, bands: s.truth.bands.filter((b) => b.color === RED).map((b) => ({ ...b, kind })) }],
      legend: { [RED]: kind },
      expect: { halls: 1 },
    });
  }

  // 9. An uncertain scan: coarse, noisy, no printed grid size or dimensions.
  {
    const sheet = { width: 120, height: 75 };
    const s = singleHall();
    const prims = s.prims.filter((p) => p.t !== 'line' || p.color === GRID_LINE);
    await raster(prims, sheet, 6, 'uncertain-scan.jpg', { jpegQuality: 35, noise: 18 });
    write({
      case: 'uncertain-scan',
      file: 'uncertain-scan.jpg',
      source: 'Synthetic scene: single-hall at 6 px/m, JPEG 35, noise; nothing states the scale.',
      sheet,
      gridMetres: 1,
      halls: [{ ...s.truth, printed: undefined }],
      legend: {},
      expect: { scaleStatus: ['unknown'] },
    });
  }

  // 10. Two pages showing the same hall: the second is a repeat.
  {
    const sheet = { width: 120, height: 75 };
    const s = singleHall({ x: 10, y: 14 }, { w: 60, h: 40 }, 'HALL K');
    const page = [...s.prims, ...legend(80, 14, LEGEND_ROWS), { t: 'text' as const, x: 80, y: 30, size: 1.2, text: 'GRID SIZE 1M X 1M' }];
    writeFileSync(join(OUT, 'two-pages-same-hall.pdf'), pdf([{ prims: page, sheet }, { prims: page, sheet }], 14));
    write({
      case: 'two-pages-same-hall',
      file: 'two-pages-same-hall.pdf',
      source: 'Synthetic scene: one hall printed on two pages.',
      sheet,
      gridMetres: 1,
      halls: [s.truth, { ...s.truth, page: 2 }],
      legend: LEGEND_KINDS,
      expect: { duplicateOnPage: 2 },
    });
  }

  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(truths.map((t) => `${t.case}.truth.json`), null, 2)}\n`);
  console.log(`Wrote ${truths.length} synthetic plans to ${OUT}`);
}

/** Whether a grid line lies entirely inside a rectangle (it is not drawn there). */
function insideStrict(p: Extract<Prim, { t: 'line' }>, r: Rect): boolean {
  const inX = (x: number) => x > r.x && x < r.x + r.w;
  const inY = (y: number) => y > r.y && y < r.y + r.h;
  return (p.x1 === p.x2 && inX(p.x1) && p.y1 < r.y + r.h && p.y2 > r.y) || (p.y1 === p.y2 && inY(p.y1) && p.x1 < r.x + r.w && p.x2 > r.x);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
