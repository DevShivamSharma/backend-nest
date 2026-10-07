/**
 * Measures how well floor-plan texts are read, against test/fixtures/plan-texts/eval.json.
 *
 *   npm run eval:plan-texts              rules alone (no model server needed)
 *   npm run eval:plan-texts -- --model   rules, then the local model for the rest
 *   ... -- --model --only=general        one source group
 *
 * Accuracy is reported per group, because stall codes outnumber everything else: a single
 * overall figure would hide mistakes on facilities and legend rows, which matter most.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { OllamaClient } from '../src/ai/ollama.client';
import { PlanTextReaderService } from '../src/ai/plan-text-reader.service';
import { PlanTextKind, ruleKind } from '../src/ai/plan-texts';
import { configuration } from '../src/config/configuration';

interface Case {
  text: string;
  kind: PlanTextKind;
  source: string;
}

const args = process.argv.slice(2);
const useModel = args.includes('--model');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const cases = (
  JSON.parse(
    readFileSync(join(__dirname, '../test/fixtures/plan-texts/eval.json'), 'utf8'),
  ) as Case[]
).filter((c) => !only || c.source.startsWith(only));

/** Where a kind puts a text in ITPO's layout: the part that matters for the plan. */
function layer(kind: PlanTextKind): string {
  if (kind.startsWith('icon:')) return 'icons';
  if (kind.startsWith('area:')) return 'legend';
  if (kind === 'label') return 'labels';
  return 'off-plan';
}

function group(c: Case): string {
  const base = c.source.split(':')[0];
  const layerName = layer(c.kind);
  return `${base} / ${layerName === 'off-plan' ? c.kind : layerName}`;
}

async function main(): Promise<void> {
  const started = Date.now();
  let predicted: Map<string, { kind: PlanTextKind; by: string; review?: boolean }>;
  let modelNote = 'rules only';

  if (useModel) {
    const config = configuration();
    if (!config.llm.baseUrl) {
      throw new Error('Set LLM_BASE_URL in .env to evaluate with the model.');
    }
    const reader = new PlanTextReaderService(
      new OllamaClient({ getOrThrow: () => config.llm } as unknown as ConfigService),
    );
    const result = await reader.classify(cases.map((c) => c.text));
    predicted = result.readings;
    modelNote = result.model.used
      ? `rules + ${result.model.name}`
      : `rules (model not used: ${result.model.note})`;
  } else {
    predicted = new Map(
      cases.map((c) => {
        const kind = ruleKind(c.text);
        return [c.text, kind ? { kind, by: 'rules' } : { kind: 'none' as const, by: 'default' }];
      }),
    );
  }

  const groups = new Map<string, { total: number; right: number; layerRight: number }>();
  const wrong: string[] = [];
  let byModel = 0;
  let review = 0;
  let accepted = 0;
  let acceptedRight = 0;
  for (const c of cases) {
    const got: { kind: PlanTextKind; by: string; review?: boolean } = predicted.get(c.text) ?? {
      kind: 'none',
      by: 'default',
      review: true,
    };
    if (got.by === 'model') byModel++;
    if (got.review) {
      review++;
    } else {
      accepted++;
      if (got.kind === c.kind) acceptedRight++;
    }
    const key = group(c);
    const g = groups.get(key) ?? { total: 0, right: 0, layerRight: 0 };
    g.total++;
    if (got.kind === c.kind) g.right++;
    if (layer(got.kind) === layer(c.kind)) g.layerRight++;
    groups.set(key, g);
    if (got.kind !== c.kind) {
      wrong.push(
        `  ${JSON.stringify(c.text)}  want ${c.kind}  got ${got.kind} (${got.by}${got.review ? ', review' : ''})`,
      );
    }
  }

  const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`.padStart(7);
  console.log(
    `\n${modelNote}; ${cases.length} texts; ${byModel} answered by the model; ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
  console.log('group'.padEnd(34), 'texts'.padStart(6), ' exact', '  layer');
  let total = 0;
  let right = 0;
  for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    total += g.total;
    right += g.right;
    console.log(
      key.padEnd(34),
      String(g.total).padStart(6),
      pct(g.right, g.total),
      pct(g.layerRight, g.total),
    );
  }
  console.log('all'.padEnd(34), String(total).padStart(6), pct(right, total));
  console.log(
    `\naccepted without review: ${accepted} texts, ${pct(acceptedRight, accepted).trim()} right; ` +
      `marked for review: ${review} (${pct(review, total).trim()})`,
  );
  if (wrong.length) {
    console.log(`\n${wrong.length} wrong:`);
    console.log(wrong.slice(0, 200).join('\n'));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
