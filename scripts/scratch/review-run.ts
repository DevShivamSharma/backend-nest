import { readFileSync } from 'node:fs';
import type { PlanTextReading } from '../../src/ai/plan-text-reader.service';
import { ruleKind } from '../../src/ai/plan-texts';
import { runDrawingAnalysis } from '../../src/integrations/drawings/drawing-analysis';
import { emptyReviewState, reviewImport } from '../../src/venues/plan-import/review';

async function main() {
  const file = process.argv[2];
  const t = Date.now();
  const out = await runDrawingAnalysis({ data: new Uint8Array(readFileSync(file)), fileName: file.split('/').pop()!, readScannedText: process.argv[3] !== 'noocr' });
  if (!out.ok) { console.log('FAILED', out.message); return; }
  const readings = new Map<string, PlanTextReading>();
  for (const s of out.analysis.sheets) for (const x of s.texts) { const k = x.text.replace(/\s+/g, ' ').trim(); const kind = ruleKind(k); readings.set(k, kind ? { kind, by: 'rules', review: false } : { kind: 'none', by: 'default', review: false }); }
  const review = reviewImport(out.analysis, readings, emptyReviewState());
  console.log(`== ${file.split('/').pop()} (${((Date.now() - t) / 1000).toFixed(1)} s) skipped ${JSON.stringify(out.analysis.skipped)}`);
  for (const [i, s] of review.entries()) {
    const sheet = out.analysis.sheets[i];
    console.log(` page ${s.page} ${sheet.format} map=${sheet.map.source} sub=${sheet.map.sub} pitch=${sheet.map.unitPxX.toFixed(2)}x${sheet.map.unitPxY.toFixed(2)} rot=${sheet.rotation} texts=${sheet.texts.length} dims=${sheet.dimensions.length} stated=${JSON.stringify(sheet.statedGrid)} file=${JSON.stringify(sheet.fileScale)}`);
    console.log(`  scale: ${s.scale.status} ${s.scale.metresPerUnit?.toFixed(4)} — ${s.scale.candidates.map((c) => `${c.source}:${c.metresPerUnit.toFixed(4)}`).join(', ')}`);
    console.log(`  dims: ${sheet.dimensions.slice(0, 12).map((d) => `${d.text}=${d.units.toFixed(2)}u`).join(' ')}`);
    console.log(`  parts: ${s.parts.filter((p) => !p.noise).map((p) => `${p.id}[${p.area.toFixed(0)}u² ${p.assignment ? p.assignment.hall + '/' + p.assignment.role : 'none'} ${p.by}${p.titles.length ? ' ' + p.titles.join('|') : ''}${p.foyerLabel ? ' F:' + p.foyerLabel : ''}${p.candidates.length ? ' ?' + p.candidates.join(',') : ''}]`).join(' ')}`);
    for (const h of s.halls) {
      console.log(`  HALL ${h.key} "${h.name}" (${h.nameFrom}) ${h.stats.width}x${h.stats.depth} m gross=${h.stats.gross} stall=${h.stats.stallFloor} foyer=${h.stats.foyer} voids=${h.stats.voids} saveable=${h.saveable}`);
      console.log(`    bands: ${h.stats.bands.map((b) => `${b.kind} ${b.area}m² (+${b.cellMaskExtra} mask)`).join(', ')}`);
      for (const c of h.checks) if (c.status !== 'info') console.log(`    [${c.status}${c.blocking ? '*' : ''}] ${c.label}: exp ${c.expected} meas ${c.measured} — ${c.evidence.slice(0, 140)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
