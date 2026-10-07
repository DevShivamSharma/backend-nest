import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
async function main() {
  const [file, scaleArg] = process.argv.slice(2);
  const scale = Number(scaleArg ?? 3);
  const t = Date.now();
  const worker = await createWorker('eng', 1, { langPath: join(__dirname, '../../node_modules/@tesseract.js-data/eng/4.0.0_best_int'), cacheMethod: 'none', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  const meta = await sharp(file).metadata();
  const png = await sharp(file).resize(Math.round(meta.width! * scale)).greyscale().png().toBuffer();
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const lines: string[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    if (l.confidence < 40 || !l.text.trim()) continue;
    lines.push(`${l.text.trim()} [${Math.round(l.confidence)}] @${Math.round(l.bbox.x0 / scale)},${Math.round(l.bbox.y0 / scale)}`);
  }
  console.log(((Date.now() - t) / 1000).toFixed(1), 's', lines.length, 'lines');
  console.log(lines.join('\n'));
  await worker.terminate();
}
main();
