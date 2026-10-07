import { readFileSync } from 'node:fs';
import { runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
import { emptyReviewState, reviewImport } from '../../src/venues/plan-import/review';
async function main() {
  const out = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(process.argv[2])), fileName: 'x', readScannedText: false });
  if (!out.ok) return;
  const r = reviewImport(out.analysis, new Map(), emptyReviewState());
  for (const h of r[0].halls) {
    const c = new Map<string, { n: number; small: number }>();
    for (const a of h.floor.areas) { const e = c.get(a.kind) ?? { n: 0, small: 0 }; e.n++; if (a.width * a.height < 0.5) e.small++; c.set(a.kind, e); }
    console.log(h.name, [...c].map(([k, e]) => `${k}:${e.n} (${e.small} <0.5m²)`).join(', '));
  }
}
main();
