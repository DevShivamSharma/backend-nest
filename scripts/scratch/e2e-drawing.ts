import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { OllamaClient } from '../../src/ai/ollama.client';
import { PlanTextReaderService } from '../../src/ai/plan-text-reader.service';
import { configuration } from '../../src/config/configuration';
import { runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
import { buildDrawingFloor } from '../../src/venues/drawing-floor';
import { floorArea } from '../../src/venues/floor/hall-floor';

async function main() {
  const [file, out, instructions] = process.argv.slice(2);
  let t = Date.now();
  const outcome = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(file)), fileName: file, gridMetres: 1, readScannedText: true });
  if (!outcome.ok) throw new Error(outcome.message);
  const a = outcome.analysis;
  console.log('analysis', ((Date.now() - t) / 1000).toFixed(1), 's', a.format, 'texts', a.texts.length, 'warnings', a.warnings);
  t = Date.now();
  const config = configuration();
  const reader = new PlanTextReaderService(new OllamaClient({ getOrThrow: () => config.llm } as unknown as ConfigService));
  const { readings, model } = await reader.classify(a.texts.map((x) => x.text), { instructions });
  console.log('classify', ((Date.now() - t) / 1000).toFixed(1), 's', model);
  const r = buildDrawingFloor(a, readings);
  console.log('floor', r.floor.width, 'x', r.floor.depth, 'areas', r.floor.areas.length, 'open m²', floorArea(r.floor));
  console.log('parts', r.parts.map((p) => `${p.id}:${p.width}x${p.height}=${p.area}${p.selected ? '*' : ''}`).join(' '));
  console.log('groups', r.groups.map((g) => `${g.family}->${g.choice} (${g.from}${g.legend ? ': ' + g.legend : ''}) ${g.area}m²`).join('\n  '));
  console.log('labels', r.floor.labels.map((l) => l.text).join(' | '));
  console.log('icons', r.floor.iconGroups.map((g) => g.icons.map((i) => i.kind).join('+')).join(' | '));
  console.log('legend', r.floor.legend.map((l) => `${l.label} => ${l.kind} ${l.color ?? ''}`).join('\n  '));
  const kinds = new Map<string, string[]>();
  for (const x of r.texts) { const k = `${x.kind}${x.review ? '?' : ''}`; kinds.set(k, [...(kinds.get(k) ?? []), x.text]); }
  for (const [k, v] of kinds) console.log(` ${k}: ${v.slice(0, 14).join(' | ')}${v.length > 14 ? ` (+${v.length - 14})` : ''}`);
  if (out) writeFileSync(out, JSON.stringify(r.floor));
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
