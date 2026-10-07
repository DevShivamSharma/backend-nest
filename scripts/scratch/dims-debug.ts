import { readFileSync } from 'node:fs';
import { runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
async function main() {
  const out = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(process.argv[2])), fileName: process.argv[2], readScannedText: true });
  if (!out.ok) return console.log(out.message);
  const s = out.analysis.sheets[0];
  console.log('texts:', s.texts.map((t) => `${t.text}@${t.x.toFixed(1)},${t.y.toFixed(1)} ${t.width.toFixed(1)}x${t.height.toFixed(1)}`).join(' | '));
  console.log('dims:', JSON.stringify(s.dimensions));
}
main();
