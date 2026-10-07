import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { decodeMapCells, runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
const PAL: Record<string, [number, number, number]> = { grey: [120, 120, 120], red: [255, 0, 0], orange: [255, 150, 0], yellow: [230, 200, 0], green: [0, 160, 0], blue: [0, 0, 255], purple: [140, 40, 230], magenta: [255, 0, 255], dark: [30, 30, 30] };
async function main() {
  const [file, out, crop] = process.argv.slice(2);
  const res = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(file)), fileName: 'x', readScannedText: false });
  if (!res.ok) return;
  const s = res.analysis.sheets[0];
  const cells = decodeMapCells(s.map);
  const { cols, rows } = s.map;
  const buf = Buffer.alloc(cols * rows * 3);
  for (let k = 0; k < cells.length; k++) {
    const v = cells[k];
    buf.set(v === -2 ? [255, 255, 255] : v === -1 ? [200, 255, 200] : PAL[s.map.groups.find((g) => g.id === v)!.family] ?? [0, 0, 0], 3 * k);
  }
  let img = sharp(buf, { raw: { width: cols, height: rows, channels: 3 } });
  if (crop) { const [l, t, w, h] = crop.split(',').map(Number); img = sharp(await img.extract({ left: l, top: t, width: w, height: h }).png().toBuffer()).resize(w * 4, h * 4, { kernel: 'nearest' }); }
  await img.png().toFile(out);
  console.log(cols, rows, s.map.groups.map((g) => `${g.id}:${g.family}:${g.cells}`).join(' '));
}
main();
