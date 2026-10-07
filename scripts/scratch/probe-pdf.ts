import { readFileSync } from 'node:fs';
import { readPageVectors } from '../../src/integrations/drawings/pdf-vectors';
async function main() {
  const v = await readPageVectors(new Uint8Array(readFileSync(process.argv[2])), 1);
  console.log('page', v.width, v.height, 'layers', v.layers.length, 'paths', v.paths.length, 'texts', v.texts.length);
  const by = new Map<string, { n: number; segs: number; w: Set<string> }>();
  for (const p of v.paths) {
    const k = `${p.layer}|s=${p.stroke}|f=${p.fill}`;
    const e = by.get(k) ?? { n: 0, segs: 0, w: new Set() };
    e.n++; e.segs += p.segments.length; e.w.add(p.width.toFixed(2));
    by.set(k, e);
  }
  for (const [k, e] of [...by].sort((a, b) => b[1].segs - a[1].segs).slice(0, 40)) console.log(e.n, e.segs, [...e.w].slice(0, 4).join(','), k);
  console.log(v.texts.slice(0, 400).map((t) => `${t.text}@${t.x.toFixed(0)},${t.y.toFixed(0)},${t.size.toFixed(1)}`).join(' | '));
}
main();
