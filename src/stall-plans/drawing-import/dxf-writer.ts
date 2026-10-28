import type { PageVectors } from '../cad/pdf-vectors';

/**
 * A CAD plan PDF's drawing as an ASCII DXF (R12), for opening in AutoCAD or any CAD program: every
 * line on its own layer (the PDF's optional-content groups are AutoCAD's layers), in its colour,
 * and every text. In metres when the stall grid gave the scale, otherwise in page points; y up,
 * as CAD draws.
 */
export function vectorsToDxf(page: PageVectors, pointsPerMetre: number | null): string {
  const k = pointsPerMetre && pointsPerMetre > 0 ? 1 / pointsPerMetre : 1;
  const x = (v: number) => num(v * k);
  const y = (v: number) => num((page.height - v) * k);
  const layers = new Map<string, number>();
  const layerOf = (name: string, color: string | null) => {
    const clean = layerName(name);
    if (!layers.has(clean)) layers.set(clean, aci(color));
    return clean;
  };
  const out: string[] = [];
  const put = (...pairs: Array<string | number>) => {
    for (const p of pairs) out.push(String(p));
  };

  const entities: string[] = [];
  const add = (...pairs: Array<string | number>) => {
    for (const p of pairs) entities.push(String(p));
  };
  for (const path of page.paths) {
    const layer = layerOf(path.layer, path.stroke);
    const color = aci(path.stroke);
    for (const s of path.segments) {
      add(
        0,
        'LINE',
        8,
        layer,
        62,
        color,
        10,
        x(s.x1),
        20,
        y(s.y1),
        30,
        0,
        11,
        x(s.x2),
        21,
        y(s.y2),
        31,
        0,
      );
    }
  }
  for (const t of page.texts) {
    const text = t.text.replace(/[\r\n]+/g, ' ').trim();
    if (!text) continue;
    const layer = layerOf('TEXT', null);
    const h = num(Math.max(t.size * k, 1e-3));
    // Centred on the span's centre, as the PDF reader gives it.
    add(0, 'TEXT', 8, layer, 10, x(t.x), 20, y(t.y), 30, 0, 40, h, 1, text);
    add(50, t.vertical ? 90 : 0, 72, 1, 73, 2, 11, x(t.x), 21, y(t.y), 31, 0);
  }

  put(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 0, 'ENDSEC');
  put(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, layers.size);
  for (const [name, color] of layers) put(0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  put(0, 'ENDTAB', 0, 'ENDSEC');
  put(0, 'SECTION', 2, 'ENTITIES');
  for (const line of entities) out.push(line);
  put(0, 'ENDSEC', 0, 'EOF');
  return out.join('\n') + '\n';
}

/** A layer name AutoCAD accepts; the unnamed layer is "0". */
function layerName(name: string): string {
  const clean = name
    .replace(/[<>/\\":;?*|=`,]/g, '_')
    .trim()
    .slice(0, 255);
  return clean || '0';
}

/** The nearest of AutoCAD's basic colours to a `#rrggbb` stroke; 7 (white/black) by default. */
function aci(hex: string | null): number {
  const m = hex && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 7;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16));
  const basic: Array<[number, number, number, number]> = [
    [1, 255, 0, 0],
    [2, 255, 255, 0],
    [3, 0, 255, 0],
    [4, 0, 255, 255],
    [5, 0, 0, 255],
    [6, 255, 0, 255],
    [7, 0, 0, 0],
    [8, 128, 128, 128],
    [9, 192, 192, 192],
  ];
  let best = basic[0];
  let distance = Infinity;
  for (const c of basic) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2;
    if (d < distance) [best, distance] = [c, d];
  }
  return best[0];
}

const num = (v: number) => String(Math.round(v * 10000) / 10000);
