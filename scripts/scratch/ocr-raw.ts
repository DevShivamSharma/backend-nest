import { join } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
async function main() {
  const [file, psm] = process.argv.slice(2);
  const worker = await createWorker('eng', 1, { langPath: join(__dirname, '../../node_modules/@tesseract.js-data/eng/4.0.0_best_int'), cacheMethod: 'none', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: (psm ?? PSM.SPARSE_TEXT) as PSM });
  const meta = await sharp(file).metadata();
  const png = await sharp(file).resize(meta.width! * 3).greyscale().png().toBuffer();
  const { data } = await worker.recognize(png, {}, { blocks: true });
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) console.log(Math.round(l.confidence), JSON.stringify(l.text.trim()), l.words.map((w) => `${w.text}:${Math.round(w.confidence)}`).join(' '));
  await worker.terminate();
}
main();
