import { readFileSync } from 'node:fs';
import { runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
import { hallNameOf } from '../../src/venues/plan-import/detect-halls';
async function main() {
  const out = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(process.argv[2])), fileName: 'x', readScannedText: true });
  if (!out.ok) return;
  for (const s of out.analysis.sheets) {
    for (const t of s.texts) {
      const n = hallNameOf(t.text);
      if (n || /grid|hall|foyer|scale/i.test(t.text)) console.log(JSON.stringify(t.text), '->', n);
    }
  }
}
main();
