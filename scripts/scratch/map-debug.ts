import sharp from 'sharp';
import { analyseGrid } from '../../src/integrations/drawings/grid-map';
import { pdfImage } from './run-grid';
const PAL: Record<string, [number, number, number]> = { wall: [40, 40, 40], column: [150, 150, 150], passage: [255, 0, 0], no_build: [255, 150, 0], unavailable: [255, 0, 255], entry: [0, 160, 0], utility: [0, 0, 255], fire_curtain: [140, 40, 230] };
async function main() {
  const img = await pdfImage(process.argv[2]);
  const map = analyseGrid(img);
  const out = Buffer.alloc(map.cols * map.rows * 3);
  for (let k = 0; k < map.cells.length; k++) {
    const v = map.cells[k];
    const c: [number, number, number] = v === -2 ? [255, 255, 255] : v === -1 ? [200, 255, 200] : PAL[map.groups[v].kind] ?? [0, 0, 0];
    out.set(c, 3 * k);
  }
  console.log(map.groups.map((g) => `${g.id}:${g.family}->${g.kind} ${g.color} ${g.cells}`).join('\n'));
  await sharp(out, { raw: { width: map.cols, height: map.rows, channels: 3 } }).png().toFile(process.argv[3]);
}
main();
