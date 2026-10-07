import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { analyseGrid, mapAreas } from '../../src/integrations/drawings/grid-map';
import type { RgbImage } from '../../src/integrations/drawings/raster';
import { floorSvg } from './render-itpo';

export async function pdfImage(file: string): Promise<RgbImage> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  let best: any = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
    const img = await new Promise<any>((res) => page.objs.get(ops.argsArray[i][0], res));
    if (img?.kind === 2 && (!best || img.width * img.height > best.width * best.height)) best = img;
  }
  return { width: best.width, height: best.height, data: new Uint8Array(best.data) };
}

async function main() {
  const [file, out] = process.argv.slice(2);
  const img = file.endsWith('.pdf') ? await pdfImage(file) : await (async () => { const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data: new Uint8Array(data) }; })();
  const t = Date.now();
  const map = analyseGrid(img);
  console.log('ms', Date.now() - t, { res: map.resolution, cols: map.cols, rows: map.rows, px: map.pxPerMetreX.toFixed(3), regions: map.regions, gridCells: map.gridCells, warnings: map.warnings });
  console.log(map.groups);
  const areas = mapAreas(map, new Map());
  const floor = { schema: 'floor/1' as const, width: map.cols * map.resolution, depth: map.rows * map.resolution, areas, labels: [], iconGroups: [], north: null, legend: [] };
  console.log('areas', areas.length);
  writeFileSync(out.replace('.png', '.json'), JSON.stringify(floor));
  // overlay on plan
  const s = map.pxPerMetreX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}"><g transform="translate(${map.originX} ${map.originY}) scale(${s} ${map.pxPerMetreY})">` +
    `<rect width="${floor.width}" height="${floor.depth}" fill="#00ff00" fill-opacity="0.35"/>` +
    areas.map((a) => `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" fill="${a.kind === 'outside' ? '#000' : (a.color ?? '#f00')}" fill-opacity="${a.kind === 'outside' ? 0.45 : 0.7}" stroke="${a.kind === 'outside' ? 'none' : '#000'}" stroke-width="0.1"/>`).join('') + '</g></svg>';
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } }).composite([{ input: Buffer.from(svg) }]).png().toFile(out);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
