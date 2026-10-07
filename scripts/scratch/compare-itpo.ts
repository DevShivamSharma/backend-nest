import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { analyseGrid, FLOOR } from '../../src/integrations/drawings/grid-map';
import { itpoRowToFloor, readItpoHallRows } from '../../src/integrations/itpo/itpo-hall-layout';
import { blocksStalls } from '../../src/venues/floor/hall-floor';
import { pdfImage } from './run-grid';

type Mask = { w: number; h: number; m: Uint8Array };
function itpoMask(hallId: string): Mask {
  const row = readItpoHallRows(readFileSync('/home/cms/T_HALL_LAYOUTS.csv', 'utf8'), 'csv').find((r) => r.hallId === hallId)!;
  const { floor } = itpoRowToFloor(row);
  const w = Math.round(floor.width), h = Math.round(floor.depth);
  const m = new Uint8Array(w * h).fill(1);
  for (const a of floor.areas) {
    if (!blocksStalls(a.kind)) continue;
    for (let y = Math.max(0, Math.floor(a.y)); y < Math.min(h, Math.ceil(a.y + a.height)); y++)
      for (let x = Math.max(0, Math.floor(a.x)); x < Math.min(w, Math.ceil(a.x + a.width)); x++) {
        // cell centre inside the area
        if (x + 0.5 > a.x && x + 0.5 < a.x + a.width && y + 0.5 > a.y && y + 0.5 < a.y + a.height) m[y * w + x] = 0;
      }
  }
  return { w, h, m };
}
function ourMask(file: string): Promise<Mask> {
  return pdfImage(file).then((img) => {
    const map = analyseGrid(img);
    const s = Math.round(1 / map.resolution);
    const w = Math.floor(map.cols / s), h = Math.floor(map.rows / s);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = map.cells[(y * s + Math.floor(s / 2)) * map.cols + x * s + Math.floor(s / 2)];
      m[y * w + x] = v === FLOOR || (v >= 0 && !blocksStalls(map.groups[v].kind)) ? 1 : 0;
    }
    return { w, h, m };
  });
}
function orient(a: Mask, k: number): Mask {
  // k: 0..7 rotations/flips
  let { w, h } = a; const out: Mask = { w: k % 2 ? h : w, h: k % 2 ? w : h, m: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X = x, Y = y;
    if (k >= 4) X = w - 1 - x;
    let nx = X, ny = Y;
    const r = k % 4;
    if (r === 1) { nx = h - 1 - Y; ny = X; } else if (r === 2) { nx = w - 1 - X; ny = h - 1 - Y; } else if (r === 3) { nx = Y; ny = w - 1 - X; }
    out.m[ny * out.w + nx] = a.m[y * w + x];
  }
  return out;
}
async function main() {
  const [file, hallArg] = process.argv.slice(2);
  const ours = await ourMask(file);
  const rows = readItpoHallRows(readFileSync('/home/cms/T_HALL_LAYOUTS.csv', 'utf8'), 'csv');
  const ids = hallArg === 'auto' ? rows.map((r) => r.hallId) : [hallArg];
  for (const hallId of ids) {
  const ref = itpoMask(hallId);
  const fits = (a: number, b: number) => Math.abs(a - b) <= 0.2 * Math.max(a, b);
  if (hallArg === 'auto' && !((fits(ref.w, ours.w) && fits(ref.h, ours.h)) || (fits(ref.w, ours.h) && fits(ref.h, ours.w)))) continue;
  const sum = (m: Mask) => m.m.reduce((a, b) => a + b, 0);
  let best = { iou: 0, k: 0, dx: 0, dy: 0, inter: 0, union: 0 };
  for (let k = 0; k < 8; k++) {
    const r = orient(ref, k);
    for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) {
      let inter = 0;
      for (let y = 0; y < r.h; y++) { const oy = y + dy; if (oy < 0 || oy >= ours.h) continue;
        for (let x = 0; x < r.w; x++) { const ox = x + dx; if (ox < 0 || ox >= ours.w) continue; if (r.m[y * r.w + x] && ours.m[oy * ours.w + ox]) inter++; } }
      const union = sum(r) + sum(ours) - inter;
      if (inter / union > best.iou) best = { iou: inter / union, k, dx, dy, inter, union };
    }
  }
  if (process.argv[4]) {
    const r = orient(ref, best.k);
    const S = 6, out = Buffer.alloc(ours.w * ours.h * 3 * S * S, 255);
    for (let y = 0; y < ours.h; y++) for (let x = 0; x < ours.w; x++) {
      const o = ours.m[y * ours.w + x];
      const rx = x - best.dx, ry = y - best.dy;
      const t = rx >= 0 && ry >= 0 && rx < r.w && ry < r.h ? r.m[ry * r.w + rx] : 0;
      const c = o && t ? [200, 230, 200] : t ? [230, 0, 0] : o ? [0, 0, 230] : [255, 255, 255];
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) out.set(c, 3 * ((y * S + yy) * ours.w * S + x * S + xx));
    }
    await sharp(out, { raw: { width: ours.w * S, height: ours.h * S, channels: 3 } }).png().toFile(process.argv[4]);
  }
  console.log(`${file.split('/').pop()} vs hall ${hallId}: ours ${ours.w}x${ours.h} drawable ${sum(ours)} m² | ITPO ${ref.w}x${ref.h} drawable ${sum(ref)} m² | IoU ${(100 * best.iou).toFixed(1)}% (orientation ${best.k}, shift ${best.dx},${best.dy})`);
  }
}
main();
