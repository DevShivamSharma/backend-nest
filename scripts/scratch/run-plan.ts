import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { analyseGrid, mapAreas } from '../../src/integrations/drawings/grid-map';
import { readPlan } from '../../src/integrations/drawings/plan-source';

async function main() {
  const [file, out] = process.argv.slice(2);
  let t = Date.now();
  const plan = await readPlan(new Uint8Array(readFileSync(file)), file);
  console.log(file.split('/').pop(), plan.format, `${plan.image.width}x${plan.image.height}`, 'texts', plan.texts.length, 'read ms', Date.now() - t, plan.warnings);
  t = Date.now();
  try {
    const map = analyseGrid(plan.image);
    console.log(' grid ms', Date.now() - t, { res: map.resolution, size: `${(map.cols * map.resolution).toFixed(1)}x${(map.rows * map.resolution).toFixed(1)} m`, px: map.pxPerMetreX.toFixed(2), regions: map.regions, gridCells: map.gridCells, groups: map.groups.map((g) => `${g.family}:${g.kind}:${g.cells}`).join(' ') });
    if (!out) return;
    const areas = mapAreas(map, new Map());
    const W = map.cols * map.resolution, D = map.rows * map.resolution;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.image.width}" height="${plan.image.height}"><g transform="translate(${map.originX} ${map.originY}) scale(${map.pxPerMetreX} ${map.pxPerMetreY})">` +
      `<rect width="${W}" height="${D}" fill="#00ff00" fill-opacity="0.35"/>` +
      areas.map((a) => `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" fill="${a.kind === 'outside' ? '#000' : (a.color ?? '#f00')}" fill-opacity="${a.kind === 'outside' ? 0.45 : 0.7}"/>`).join('') + '</g>' +
      plan.texts.slice(0, 3000).map((x) => `<rect x="${x.x}" y="${x.y}" width="${x.width}" height="${x.height}" fill="none" stroke="#00f" stroke-width="1"/>`).join('') + '</svg>';
    const scale = Math.min(1, 2400 / Math.max(plan.image.width, plan.image.height));
    const composed = await sharp(Buffer.from(plan.image.data), { raw: { width: plan.image.width, height: plan.image.height, channels: 3 } }).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    await sharp(composed).resize(Math.round(plan.image.width * scale)).png().toFile(out);
  } catch (e) {
    console.log(' grid error:', (e as Error).message);
  }
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
