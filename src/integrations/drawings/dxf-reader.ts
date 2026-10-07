import { CadDrawing, CadFill, CadInsert, CadPolyline, CadText, plainText } from './cad-drawing';

/**
 * ASCII DXF reader: model-space geometry, text and block references, in world coordinates.
 *
 * Built for architectural hall plans exported from AutoCAD:
 *   - Streaming: group-code pairs are read with a cursor, never split into one huge array, so a
 *     60+ MB plan stays within a small server's memory.
 *   - Block references (INSERT) are expanded with their full transform, recursively. Bound xrefs
 *     keep most of a plan's geometry inside blocks, so without this most of the drawing is lost.
 *   - Paper space, frozen and switched-off layers are skipped: they are not part of the plan as
 *     drawn.
 *   - Curves (arcs, circles, bulges, ellipses) become short polylines.
 * DIMENSION, LEADER, VIEWPORT, IMAGE and 3D entities are ignored.
 */

export class DxfReadError extends Error {}

/** $INSUNITS -> metres per unit, for the units hall plans are drawn in. */
const UNIT_METRES: Record<number, [number, string]> = {
  1: [0.0254, 'inches'],
  2: [0.3048, 'feet'],
  4: [0.001, 'millimetres'],
  5: [0.01, 'centimetres'],
  6: [1, 'metres'],
  14: [0.1, 'decimetres'],
};

/** Budget of emitted polylines and fills; texts and block references have their own. */
const MAX_SHAPES = 600_000;
const MAX_TEXTS = 60_000;
const MAX_INSERTS = 60_000;
const MAX_DEPTH = 8;
const ARC_STEP = Math.PI / 12;

type Color = string | 'BYLAYER' | 'BYBLOCK';
type Matrix = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f

type Prim =
  | { k: 'poly'; layer: string; color: Color; pts: number[]; closed: boolean }
  | { k: 'text'; layer: string; text: string; x: number; y: number; h: number }
  | { k: 'fill'; layer: string; color: Color; loops: number[][] }
  | {
      k: 'insert';
      layer: string;
      color: Color;
      block: string;
      x: number;
      y: number;
      sx: number;
      sy: number;
      rot: number;
      flip: boolean;
      attribs: Prim[];
    };

interface BlockDef {
  baseX: number;
  baseY: number;
  prims: Prim[];
  size?: number;
}

interface LayerInfo {
  color: string | null;
  hidden: boolean;
}

type Pair = [number, string];

class PairReader {
  private pos = 0;
  code = 0;
  value = '';

  constructor(private readonly text: string) {}

  next(): boolean {
    const t = this.text;
    const nl = t.indexOf('\n', this.pos);
    if (nl < 0) return false;
    let end = t.indexOf('\n', nl + 1);
    if (end < 0) end = t.length;
    this.code = parseInt(t.slice(this.pos, nl), 10);
    let value = t.slice(nl + 1, end);
    if (value.endsWith('\r')) value = value.slice(0, -1);
    this.value = value;
    this.pos = end + 1;
    return true;
  }
}

/** Reads an ASCII DXF file (bytes as uploaded). */
export function readDxf(data: Uint8Array): CadDrawing {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 4096));
  if (head.subarray(0, 22).toString('latin1').startsWith('AutoCAD Binary DXF')) {
    throw new DxfReadError('This is a binary DXF. Save the drawing as an ASCII DXF and try again.');
  }
  const version = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head.toString('latin1'))?.[1];
  // AutoCAD 2007 (AC1021) and later write UTF-8; older files use the Windows code page.
  const encoding = version && version >= 'AC1021' ? 'utf8' : 'latin1';
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(encoding);
  if (
    !/^\s*0\s*\r?\n\s*SECTION/.test(text.slice(0, 200)) &&
    !/\n\s*0\s*\r?\n\s*SECTION/.test(text.slice(0, 2000))
  ) {
    throw new DxfReadError('The file is not a DXF drawing.');
  }
  return new DxfParser(text).parse();
}

class DxfParser {
  private readonly reader: PairReader;
  private readonly layers = new Map<string, LayerInfo>();
  private readonly blocks = new Map<string, BlockDef>();
  private readonly model: Prim[] = [];
  /** Paper-space entities (the plotted sheet: title block, often the legend). */
  private readonly paper: Prim[] = [];
  private readonly paperBlocks: Prim[][] = [];
  private insunits = 0;
  private readonly warnings = new Set<string>();

  // Output (swapped while a sheet is emitted)
  private polylines: CadPolyline[] = [];
  private texts: CadText[] = [];
  private inserts: CadInsert[] = [];
  private fills: CadFill[] = [];
  private shapeBudgetHit = false;

  constructor(text: string) {
    this.reader = new PairReader(text);
  }

  parse(): CadDrawing {
    this.readSections();
    this.emit(this.model, [1, 0, 0, 1, 0, 0], null, null, 0);
    const model = {
      polylines: this.polylines,
      texts: this.texts,
      inserts: this.inserts,
      fills: this.fills,
    };
    const sheets = [this.paper, ...this.paperBlocks]
      .filter((prims) => prims.length)
      .slice(0, 10)
      .map((prims) => {
        this.polylines = [];
        this.texts = [];
        this.inserts = [];
        this.fills = [];
        this.emit(prims, [1, 0, 0, 1, 0, 0], null, null, 0);
        return { texts: this.texts, fills: this.fills, polylines: this.polylines };
      });
    Object.assign(this, model);
    const units = UNIT_METRES[this.insunits];
    return {
      format: 'dxf',
      metresPerUnit: units ? units[0] : null,
      scaleSource: units ? `Drawing units: ${units[1]}` : 'Drawing units not set in the file',
      polylines: this.polylines,
      texts: this.texts,
      inserts: this.inserts,
      fills: this.fills,
      layers: [...this.layers.keys()],
      sheets,
      warnings: [...this.warnings],
    };
  }

  // --- reading ----------------------------------------------------------------------------

  private readSections(): void {
    const r = this.reader;
    let have = r.next();
    let section = '';
    let block: BlockDef | null = null;
    let blockName = '';
    // Multi-record entities: POLYLINE + VERTEX... + SEQEND, INSERT + ATTRIB... + SEQEND.
    let openPoly: { pairs: Pair[]; pts: number[]; bulges: number[] } | null = null;
    let openInsert: Extract<Prim, { k: 'insert' }> | null = null;

    let paperSpace = false;
    const target = (): Prim[] =>
      section === 'BLOCKS' ? (block?.prims ?? []) : paperSpace ? this.paper : this.model;

    while (have) {
      if (r.code !== 0) {
        have = r.next();
        continue;
      }
      const type = r.value;
      const skipPairs = section === 'OBJECTS' || section === 'CLASSES' || section === 'ACDSDATA';
      const pairs: Pair[] = [];
      while ((have = r.next()) && r.code !== 0) if (!skipPairs) pairs.push([r.code, r.value]);

      if (type === 'SECTION') {
        section = value(pairs, 2) ?? '';
        if (section === 'HEADER') this.readHeader(pairs);
        continue;
      }
      if (type === 'ENDSEC') {
        section = '';
        continue;
      }
      if (type === 'EOF') break;
      if (section === 'TABLES') {
        if (type === 'LAYER') this.readLayer(pairs);
        continue;
      }
      if (section !== 'BLOCKS' && section !== 'ENTITIES') continue;

      if (section === 'BLOCKS' && type === 'BLOCK') {
        blockName = value(pairs, 2) ?? '';
        block = { baseX: num(pairs, 10), baseY: num(pairs, 20), prims: [] };
        continue;
      }
      if (section === 'BLOCKS' && type === 'ENDBLK') {
        if (block && blockName) {
          if (/^\*paper_space/i.test(blockName)) this.paperBlocks.push(block.prims);
          else this.blocks.set(blockName, block);
        }
        block = null;
        continue;
      }

      // Continuations of multi-record entities.
      if (type === 'VERTEX' && openPoly) {
        openPoly.pts.push(num(pairs, 10), num(pairs, 20));
        openPoly.bulges.push(num(pairs, 42));
        continue;
      }
      if (type === 'ATTRIB' && openInsert) {
        const text = this.text(pairs, 'ATTRIB');
        if (text) openInsert.attribs.push(text);
        continue;
      }
      if (type === 'SEQEND') {
        if (openPoly) {
          const prim = this.polylineFromVertices(openPoly.pairs, openPoly.pts, openPoly.bulges);
          if (prim) target().push(prim);
        }
        openPoly = null;
        openInsert = null;
        continue;
      }
      openPoly = null;
      openInsert = null;

      paperSpace = value(pairs, 67) === '1';
      if (type === 'POLYLINE') {
        const flags = int(pairs, 70);
        if (!(flags & (16 | 64))) openPoly = { pairs, pts: [], bulges: [] }; // skip meshes
        continue;
      }
      const prims = this.entity(type, pairs);
      for (const prim of prims) {
        target().push(prim);
        if (prim.k === 'insert' && value(pairs, 66) === '1') openInsert = prim;
      }
    }
  }

  private readHeader(pairs: Pair[]): void {
    for (let i = 0; i < pairs.length - 1; i++) {
      if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
        this.insunits = parseInt(pairs[i + 1][1], 10) || 0;
      }
    }
  }

  private readLayer(pairs: Pair[]): void {
    const name = value(pairs, 2);
    if (!name) return;
    const aci = int(pairs, 62);
    const flags = int(pairs, 70);
    const truecolor = value(pairs, 420);
    this.layers.set(name, {
      color: truecolor ? trueColor(truecolor) : aciColor(Math.abs(aci)),
      hidden: aci < 0 || (flags & 1) === 1,
    });
  }

  // --- entities (in the coordinates of the block or model space they belong to) -----------

  private entity(type: string, pairs: Pair[]): Prim[] {
    const layer = value(pairs, 8) ?? '0';
    const color = entityColor(pairs);
    const flip = num(pairs, 230, 1) < 0; // OCS with a -Z extrusion mirrors X
    const fx = (x: number) => (flip ? -x : x);

    switch (type) {
      case 'LINE':
        return [
          {
            k: 'poly',
            layer,
            color,
            closed: false,
            pts: [num(pairs, 10), num(pairs, 20), num(pairs, 11), num(pairs, 21)],
          },
        ];
      case 'LWPOLYLINE': {
        const pts: number[] = [];
        const bulges: number[] = [];
        for (const [code, v] of pairs) {
          if (code === 10) {
            pts.push(fx(parseFloat(v)), 0);
            bulges.push(0);
          } else if (code === 20 && pts.length) pts[pts.length - 1] = parseFloat(v);
          else if (code === 42 && bulges.length)
            bulges[bulges.length - 1] = flip ? -parseFloat(v) : parseFloat(v);
        }
        const closed = (int(pairs, 70) & 1) === 1;
        return pts.length >= 4
          ? [{ k: 'poly', layer, color, closed, pts: withBulges(pts, bulges, closed) }]
          : [];
      }
      case 'CIRCLE': {
        const [cx, cy, r] = [fx(num(pairs, 10)), num(pairs, 20), num(pairs, 40)];
        return r > 0
          ? [
              {
                k: 'poly',
                layer,
                color,
                closed: true,
                pts: arcPoints(cx, cy, r, 0, 2 * Math.PI, true),
              },
            ]
          : [];
      }
      case 'ARC': {
        const [cx, cy, r] = [num(pairs, 10), num(pairs, 20), num(pairs, 40)];
        let a0 = (num(pairs, 50) * Math.PI) / 180;
        let a1 = (num(pairs, 51) * Math.PI) / 180;
        if (a1 <= a0) a1 += 2 * Math.PI;
        const pts = arcPoints(cx, cy, r, a0, a1, false);
        if (flip) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];
        return r > 0 ? [{ k: 'poly', layer, color, closed: false, pts }] : [];
      }
      case 'ELLIPSE': {
        const [cx, cy, mx, my, ratio] = [
          num(pairs, 10),
          num(pairs, 20),
          num(pairs, 11),
          num(pairs, 21),
          num(pairs, 40, 1),
        ];
        const t0 = num(pairs, 41);
        let t1 = num(pairs, 42, 2 * Math.PI);
        if (t1 <= t0) t1 += 2 * Math.PI;
        const pts: number[] = [];
        const steps = Math.max(8, Math.ceil((t1 - t0) / ARC_STEP));
        for (let i = 0; i <= steps; i++) {
          const t = t0 + ((t1 - t0) * i) / steps;
          pts.push(
            cx + mx * Math.cos(t) - my * ratio * Math.sin(t),
            cy + my * Math.cos(t) + mx * ratio * Math.sin(t),
          );
        }
        return [{ k: 'poly', layer, color, closed: Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6, pts }];
      }
      case 'SPLINE': {
        const fit = collectXY(pairs, 11, 21);
        const pts = fit.length >= 4 ? fit : collectXY(pairs, 10, 20);
        return pts.length >= 4
          ? [{ k: 'poly', layer, color, closed: (int(pairs, 70) & 1) === 1, pts }]
          : [];
      }
      case 'SOLID':
      case 'TRACE': {
        const q = [10, 11, 13, 12].flatMap((c) => [fx(num(pairs, c)), num(pairs, c + 10)]);
        return [{ k: 'fill', layer, color, loops: [q] }];
      }
      case 'HATCH': {
        const loops = hatchLoops(pairs).map((loop) =>
          flip ? loop.map((v, i) => (i % 2 ? v : -v)) : loop,
        );
        return loops.length ? [{ k: 'fill', layer, color, loops }] : [];
      }
      case 'TEXT':
      case 'MTEXT': {
        const text = this.text(pairs, type);
        return text ? [text] : [];
      }
      case 'INSERT': {
        const block = value(pairs, 2);
        if (!block) return [];
        return [
          {
            k: 'insert',
            layer,
            color,
            block,
            x: fx(num(pairs, 10)),
            y: num(pairs, 20),
            sx: num(pairs, 41, 1) * (flip ? -1 : 1),
            sy: num(pairs, 42, 1),
            rot: flip ? -num(pairs, 50) : num(pairs, 50),
            flip,
            attribs: [],
          },
        ];
      }
      default:
        return [];
    }
  }

  /** TEXT, MTEXT or ATTRIB, as a text centred where it is drawn. */
  private text(pairs: Pair[], type: string): Extract<Prim, { k: 'text' }> | null {
    const layer = value(pairs, 8) ?? '0';
    const flip = num(pairs, 230, 1) < 0;
    if (type === 'ATTRIB' && (int(pairs, 70) & 1) === 1) return null; // invisible attribute
    const h = Math.abs(num(pairs, 40, 1)) || 1;

    if (type === 'MTEXT') {
      const raw =
        pairs
          .filter(([c]) => c === 3)
          .map(([, v]) => v)
          .join('') + (value(pairs, 1) ?? '');
      const lines = raw.split(/\\P/).map(plainText).filter(Boolean);
      const text = plainText(raw);
      if (!text) return null;
      const longest = Math.max(...lines.map((l) => l.length), 1);
      const w = Math.max(num(pairs, 41), h * 0.62 * longest);
      const totalH = h * (1 + 1.6 * (Math.max(lines.length, 1) - 1));
      const attach = int(pairs, 71) || 1;
      const col = (attach - 1) % 3;
      const row = Math.floor((attach - 1) / 3);
      const dx = col === 0 ? w / 2 : col === 1 ? 0 : -w / 2;
      const dy = row === 0 ? -totalH / 2 : row === 1 ? 0 : totalH / 2;
      const dirX = value(pairs, 11);
      const angle =
        dirX !== undefined ? Math.atan2(num(pairs, 21), num(pairs, 11)) : num(pairs, 50);
      const [ox, oy] = rotate(dx, dy, angle);
      const x = num(pairs, 10) + ox;
      return { k: 'text', layer, text, x: flip ? -x : x, y: num(pairs, 20) + oy, h };
    }

    const text = plainText(value(pairs, 1) ?? '');
    if (!text) return null;
    const hAlign = int(pairs, 72);
    const vAlign = int(pairs, type === 'ATTRIB' ? 74 : 73);
    const angle = (num(pairs, 50) * Math.PI) / 180;
    const w = h * 0.62 * text.length * num(pairs, 41, 1);
    let x: number;
    let y: number;
    if ((hAlign === 3 || hAlign === 5) && value(pairs, 11) !== undefined) {
      x = (num(pairs, 10) + num(pairs, 11)) / 2; // aligned / fit: between the two points
      y = (num(pairs, 20) + num(pairs, 21)) / 2;
      [x, y] = [x + rotate(0, h / 2, angle)[0], y + rotate(0, h / 2, angle)[1]];
    } else {
      const aligned = (hAlign !== 0 || vAlign !== 0) && value(pairs, 11) !== undefined;
      const ax = aligned ? num(pairs, 11) : num(pairs, 10);
      const ay = aligned ? num(pairs, 21) : num(pairs, 20);
      const dx = hAlign === 0 ? w / 2 : hAlign === 2 ? -w / 2 : 0;
      const dy = hAlign === 4 || vAlign === 2 ? 0 : vAlign === 3 ? -h / 2 : h / 2;
      const [ox, oy] = rotate(dx, dy, angle);
      x = ax + ox;
      y = ay + oy;
    }
    return { k: 'text', layer, text, x: flip ? -x : x, y, h };
  }

  private polylineFromVertices(pairs: Pair[], pts: number[], bulges: number[]): Prim | null {
    if (pts.length < 4) return null;
    const flip = num(pairs, 230, 1) < 0;
    const closed = (int(pairs, 70) & 1) === 1;
    const points = flip ? pts.map((v, i) => (i % 2 ? v : -v)) : pts;
    return {
      k: 'poly',
      layer: value(pairs, 8) ?? '0',
      color: entityColor(pairs),
      closed,
      pts: withBulges(points, flip ? bulges.map((b) => -b) : bulges, closed),
    };
  }

  // --- expansion into world coordinates ---------------------------------------------------

  private emit(
    prims: Prim[],
    m: Matrix,
    parentLayer: string | null,
    parentColor: string | null,
    depth: number,
  ): void {
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    for (const prim of prims) {
      const layer = prim.layer === '0' && parentLayer ? parentLayer : prim.layer;
      if (this.layers.get(layer)?.hidden) continue;

      if (prim.k === 'text') {
        if (this.texts.length >= MAX_TEXTS) continue;
        const [x, y] = apply(m, prim.x, prim.y);
        this.texts.push({ layer, text: prim.text, x, y, height: prim.h * scale });
        continue;
      }
      const color = this.resolveColor(prim.color, layer, parentColor);
      if (prim.k === 'poly') {
        if (!this.shapeBudget()) continue;
        this.polylines.push({ layer, color, closed: prim.closed, points: applyAll(m, prim.pts) });
      } else if (prim.k === 'fill') {
        if (!this.shapeBudget()) continue;
        this.fills.push({ layer, color, loops: prim.loops.map((loop) => applyAll(m, loop)) });
      } else {
        const def = this.blocks.get(prim.block);
        const [x, y] = apply(m, prim.x, prim.y);
        // The attributes are positioned in the insert's own coordinate space, not the block's.
        this.emit(prim.attribs, m, layer, color, depth);
        if (!def) continue;
        const local = compose(
          m,
          compose(
            [1, 0, 0, 1, prim.x, prim.y],
            compose(rotation(prim.rot), [
              prim.sx,
              0,
              0,
              prim.sy,
              -def.baseX * prim.sx,
              -def.baseY * prim.sy,
            ]),
          ),
        );
        if (this.inserts.length < MAX_INSERTS) {
          const angle = (Math.atan2(local[1], local[0]) * 180) / Math.PI;
          this.inserts.push({
            layer,
            block: prim.block,
            x,
            y,
            rotation: angle,
            size:
              this.blockSize(def) * Math.sqrt(Math.abs(local[0] * local[3] - local[1] * local[2])),
          });
        }
        if (depth >= MAX_DEPTH) {
          this.warnings.add('Some deeply nested blocks were not expanded.');
          continue;
        }
        this.emit(def.prims, local, layer, color, depth + 1);
      }
    }
  }

  private shapeBudget(): boolean {
    if (this.polylines.length + this.fills.length < MAX_SHAPES) return true;
    if (!this.shapeBudgetHit) {
      this.shapeBudgetHit = true;
      this.warnings.add('The drawing is very large; only part of its linework was read.');
    }
    return false;
  }

  private resolveColor(color: Color, layer: string, parent: string | null): string | null {
    if (color === 'BYBLOCK') return parent;
    if (color === 'BYLAYER') return this.layers.get(layer)?.color ?? null;
    return color;
  }

  private blockSize(def: BlockDef): number {
    if (def.size !== undefined) return def.size;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of def.prims) {
      const pts =
        p.k === 'poly' ? p.pts : p.k === 'fill' ? p.loops.flat() : p.k === 'text' ? [p.x, p.y] : [];
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]);
        maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]);
        maxY = Math.max(maxY, pts[i + 1]);
      }
    }
    def.size = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
    return def.size;
  }
}

// --- helpers ------------------------------------------------------------------------------

function value(pairs: Pair[], code: number): string | undefined {
  for (const [c, v] of pairs) if (c === code) return v;
  return undefined;
}

function num(pairs: Pair[], code: number, fallback = 0): number {
  const v = value(pairs, code);
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(pairs: Pair[], code: number): number {
  const v = value(pairs, code);
  return v === undefined ? 0 : parseInt(v, 10) || 0;
}

function collectXY(pairs: Pair[], xCode: number, yCode: number): number[] {
  const out: number[] = [];
  for (const [c, v] of pairs) {
    if (c === xCode) out.push(parseFloat(v), 0);
    else if (c === yCode && out.length) out[out.length - 1] = parseFloat(v);
  }
  return out;
}

function entityColor(pairs: Pair[]): Color {
  const truecolor = value(pairs, 420);
  if (truecolor) return trueColor(truecolor);
  const aci = value(pairs, 62);
  if (aci === undefined) return 'BYLAYER';
  const n = parseInt(aci, 10);
  if (n === 0) return 'BYBLOCK';
  if (n === 256 || !Number.isFinite(n)) return 'BYLAYER';
  return aciColor(Math.abs(n)) ?? 'BYLAYER';
}

function trueColor(raw: string): string {
  const n = parseInt(raw, 10) & 0xffffff;
  return '#' + n.toString(16).padStart(6, '0');
}

/** AutoCAD Color Index -> hex. Exact for 1-9 and the greys; the 10-249 wheel approximated. */
export function aciColor(index: number): string | null {
  const base: Record<number, string> = {
    1: '#ff0000',
    2: '#ffff00',
    3: '#00ff00',
    4: '#00ffff',
    5: '#0000ff',
    6: '#ff00ff',
    7: '#1f2430', // white-or-black: dark on a light page
    8: '#808080',
    9: '#c0c0c0',
    250: '#333333',
    251: '#505050',
    252: '#696969',
    253: '#828282',
    254: '#bebebe',
    255: '#ffffff',
  };
  if (base[index]) return base[index];
  if (index < 10 || index > 249) return null;
  const hue = Math.floor((index - 10) / 10) * 15;
  const variant = (index - 10) % 10;
  const v = [1, 1, 0.8, 0.8, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3][variant];
  const s = variant % 2 ? 0.5 : 1;
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function rotate(x: number, y: number, angle: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

function rotation(degrees: number): Matrix {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
}

function compose(p: Matrix, q: Matrix): Matrix {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function applyAll(m: Matrix, pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
    out[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
  }
  return out;
}

function arcPoints(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  closed: boolean,
): number[] {
  const steps = Math.max(closed ? 24 : 4, Math.ceil((a1 - a0) / ARC_STEP));
  const pts: number[] = [];
  const last = closed ? steps - 1 : steps;
  for (let i = 0; i <= last; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

/** Replaces bulged polyline segments with short arcs. */
function withBulges(pts: number[], bulges: number[], closed: boolean): number[] {
  if (!bulges.some((b) => b !== 0)) return pts;
  const n = pts.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = pts[2 * i];
    const y0 = pts[2 * i + 1];
    out.push(x0, y0);
    const b = bulges[i] ?? 0;
    if (b === 0 || (!closed && i === n - 1)) continue;
    const j = (i + 1) % n;
    const x1 = pts[2 * j];
    const y1 = pts[2 * j + 1];
    const chord = Math.hypot(x1 - x0, y1 - y0);
    if (chord === 0) continue;
    const theta = 4 * Math.atan(b);
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const d = r * Math.cos(theta / 2);
    const cx = mx - (d * (y1 - y0)) / chord;
    const cy = my + (d * (x1 - x0)) / chord;
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / ARC_STEP));
    for (let s = 1; s < steps; s++) {
      const a = a0 + (theta * s) / steps;
      out.push(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a));
    }
  }
  return out;
}

/** The boundary loops of a HATCH entity (polyline paths and line/arc edge paths). */
function hatchLoops(pairs: Pair[]): number[][] {
  const loops: number[][] = [];
  let i = pairs.findIndex(([c]) => c === 91);
  if (i < 0) return loops;
  const pathCount = parseInt(pairs[i][1], 10) || 0;
  i++;
  const read = (code: number): number => {
    while (i < pairs.length && pairs[i][0] !== code) i++;
    return i < pairs.length ? parseFloat(pairs[i++][1]) : 0;
  };
  for (let p = 0; p < pathCount && i < pairs.length; p++) {
    const flags = read(92);
    const loop: number[] = [];
    if (flags & 2) {
      // Polyline path: 72 has-bulge, 73 closed, 93 vertex count, then 10/20 [42].
      const hasBulge = read(72) !== 0;
      read(73);
      const count = read(93);
      const bulges: number[] = [];
      for (let v = 0; v < count; v++) {
        loop.push(read(10), read(20));
        bulges.push(hasBulge && pairs[i]?.[0] === 42 ? parseFloat(pairs[i++][1]) : 0);
      }
      loops.push(withBulges(loop, bulges, true));
    } else {
      const edges = read(93);
      for (let e = 0; e < edges; e++) {
        const kind = read(72);
        if (kind === 1) {
          loop.push(read(10), read(20));
          read(11);
          read(21);
        } else if (kind === 2) {
          const [cx, cy, r, a0, a1] = [read(10), read(20), read(40), read(50), read(51)];
          const ccw = read(73) !== 0;
          const s = (a0 * Math.PI) / 180;
          let t = (a1 * Math.PI) / 180;
          if (t <= s) t += 2 * Math.PI;
          const pts = arcPoints(cx, cy, r, s, t, false);
          if (!ccw) for (let k = 1; k < pts.length; k += 2) pts[k] = 2 * cy - pts[k];
          loop.push(...pts.slice(0, -2));
        } else if (kind === 3) {
          loop.push(read(10), read(20));
        } else if (kind === 4) {
          const knots = read(95);
          const controls = read(96);
          for (let k = 0; k < knots; k++) read(40);
          for (let k = 0; k < controls; k++) loop.push(read(10), read(20));
        }
      }
      if (loop.length >= 6) loops.push(loop);
    }
    // Source boundary object handles.
    const sources = read(97);
    for (let s = 0; s < sources; s++) read(330);
  }
  return loops.filter((l) => l.length >= 6);
}
