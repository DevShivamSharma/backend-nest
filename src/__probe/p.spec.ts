import { readFileSync, writeFileSync } from 'fs';
import { runDrawingJob } from '../stall-plans/drawing-import/drawing-import.job';
it('probe', async () => {
  const out = await runDrawingJob({ kind: 'stalls', data: new Uint8Array(readFileSync(process.env.F!)), page: 1 });
  if (!out.ok || out.kind !== 'stalls') throw new Error(JSON.stringify(out));
  const r = out.result;
  if (process.env.RES) writeFileSync(process.env.RES, JSON.stringify(r));
  const sug = r.stalls.filter((s) => s.issues.some((i) => i.code === 'NO_OUTLINE'));
  console.log(JSON.stringify({ stalls: r.stalls.length, groups: r.groups.map((g) => g.group), unresolved: r.unresolved.map((u) => u.texts), suggested: sug.map((s) => ({ n: s.name, area: s.area, label: s.labels.area, outline: s.outline, issues: s.issues.map((i) => i.code) })), shapes: r.stalls.filter((s) => s.shape !== 'rectangle').map((s) => `${s.name}:${s.shape}`) }));
}, 180000);
