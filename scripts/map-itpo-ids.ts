import 'reflect-metadata';

import { readFileSync } from 'node:fs';

import dataSource from '../src/database/data-source';

/**
 * Links an organisation's halls and stall categories to their SelfCare ids by name, so a plan
 * push can name ITPO's hall and `T_CODE_MASTER` categories (docs/15 §4). The file is what the
 * operator exports from ITPO's read-only database (either key may be left out):
 *
 *   { "halls": [{ "id": 56, "name": "Hall 12" }], "categories": [{ "id": 137, "name": "Shell" }] }
 *
 *   & $node --env-file=.env -r ts-node/register scripts/map-itpo-ids.ts --org <slug> --file <export.json> [--write]
 *
 * Names match after lower-casing and removing everything but letters and digits ("Hall-12" is
 * "hall 12"). It prints, for each side, what matched, what is already linked (never
 * overwritten), what is ambiguous (two names alike on one side) and what did not match.
 * Without --write it changes nothing; with it, the matches are inserted in one transaction.
 */

type EntityType = 'hall' | 'category';

interface TheirRow {
  id: string;
  name: string;
}

interface OurRow {
  id: string;
  name: string;
}

interface Match {
  local: OurRow;
  external: TheirRow;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const normalise = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The export's rows of one kind; rows without a whole-number id or a name are reported. */
function theirRows(value: unknown, kind: string): TheirRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`"${kind}" in the file must be a list.`);
  const rows: TheirRow[] = [];
  value.forEach((raw: unknown, index: number) => {
    const row = raw as { id?: unknown; name?: unknown } | null;
    const id = row?.id;
    const name = row?.name;
    if (
      (typeof id !== 'number' && typeof id !== 'string') ||
      !/^\d+$/.test(String(id)) ||
      typeof name !== 'string' ||
      !name.trim()
    ) {
      console.log(`  skipped ${kind}[${index}]: it needs a whole-number "id" and a "name".`);
      return;
    }
    rows.push({ id: String(id), name: name.trim() });
  });
  return rows;
}

function byName<T extends { name: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalise(row.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** Pairs one side by name and prints the outcome; returns the pairs to insert. */
function pair(
  entityType: EntityType,
  ours: OurRow[],
  theirs: TheirRow[],
  linked: Array<{ localId: string; externalId: string }>,
): Match[] {
  const label = entityType === 'hall' ? 'Halls' : 'Categories';
  console.log(`\n${label}: ${ours.length} here, ${theirs.length} in the file`);
  const byLocal = new Map(linked.map((l) => [l.localId, l.externalId]));
  const byExternal = new Map(linked.map((l) => [l.externalId, l.localId]));
  const ourGroups = byName(ours);
  const theirGroups = byName(theirs);
  const matched: Match[] = [];
  const lines = {
    matched: [] as string[],
    linked: [] as string[],
    ambiguous: [] as string[],
    unmatched: [] as string[],
  };

  for (const [key, mine] of ourGroups) {
    const other = theirGroups.get(key);
    if (!other) {
      for (const m of mine) lines.unmatched.push(`here: "${m.name}"`);
      continue;
    }
    if (mine.length > 1 || other.length > 1) {
      lines.ambiguous.push(
        `${mine.map((m) => `"${m.name}"`).join(', ')} here ~ ` +
          `${other.map((t) => `"${t.name}" (${t.id})`).join(', ')} in the file`,
      );
      continue;
    }
    const [local] = mine;
    const [external] = other;
    const current = byLocal.get(local.id);
    if (current !== undefined) {
      lines.linked.push(
        current === external.id
          ? `"${local.name}" -> ${current} (same id)`
          : `"${local.name}" -> ${current}; the file says ${external.id}, kept ${current}`,
      );
      continue;
    }
    const owner = byExternal.get(external.id);
    if (owner !== undefined) {
      lines.linked.push(`SelfCare ${external.id} ("${external.name}") is linked to another record here`);
      continue;
    }
    matched.push({ local, external });
    lines.matched.push(`"${local.name}" -> ${external.id} ("${external.name}")`);
  }
  for (const [key, other] of theirGroups) {
    if (!ourGroups.has(key)) {
      for (const t of other) lines.unmatched.push(`file: "${t.name}" (${t.id})`);
    }
  }

  for (const [title, list] of Object.entries(lines)) {
    console.log(`  ${title} (${list.length})`);
    for (const line of list) console.log(`    ${line}`);
  }
  return matched;
}

async function main(): Promise<void> {
  const slug = arg('--org')?.trim();
  const file = arg('--file');
  const write = process.argv.includes('--write');
  if (!slug || !file) {
    throw new Error('Usage: scripts/map-itpo-ids.ts --org <slug> --file <export.json> [--write]');
  }
  let parsed: { halls?: unknown; categories?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
  } catch {
    throw new Error(`${file} is not a readable JSON file.`);
  }
  const theirHalls = theirRows(parsed.halls, 'halls');
  const theirCategories = theirRows(parsed.categories, 'categories');

  await dataSource.initialize();
  try {
    const [organisation]: Array<{ id: string; name: string }> = await dataSource.query(
      `SELECT id, name FROM organisations WHERE slug = $1`,
      [slug],
    );
    if (!organisation) throw new Error(`No organisation has the slug "${slug}".`);
    console.log(`Organisation: ${organisation.name}`);

    const halls: OurRow[] = await dataSource.query(
      `SELECT id, name FROM halls WHERE organisation_id = $1 ORDER BY name`,
      [organisation.id],
    );
    const categories: OurRow[] = await dataSource.query(
      `SELECT id, name FROM stall_categories WHERE organisation_id = $1 ORDER BY name`,
      [organisation.id],
    );
    const refs: Array<{ entity_type: EntityType; local_id: string; external_id: string }> =
      await dataSource.query(
        `SELECT entity_type, local_id, external_id FROM external_refs
          WHERE organisation_id = $1 AND system = 'itpo' AND entity_type IN ('hall', 'category')`,
        [organisation.id],
      );
    const linked = (type: EntityType) =>
      refs
        .filter((r) => r.entity_type === type)
        .map((r) => ({ localId: r.local_id, externalId: r.external_id }));

    const toInsert = [
      ...(parsed.halls === undefined
        ? []
        : pair('hall', halls, theirHalls, linked('hall')).map((m) => ({ type: 'hall', ...m }))),
      ...(parsed.categories === undefined
        ? []
        : pair('category', categories, theirCategories, linked('category')).map((m) => ({
            type: 'category',
            ...m,
          }))),
    ];

    if (!write) {
      console.log(`\n${toInsert.length} link(s) would be written. Run again with --write to write them.`);
      return;
    }
    const inserted = await dataSource.transaction(async (em) => {
      let count = 0;
      for (const m of toInsert) {
        const rows: unknown[] = await em.query(
          `INSERT INTO external_refs (organisation_id, system, entity_type, local_id, external_id)
           VALUES ($1, 'itpo', $2, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [organisation.id, m.type, m.local.id, m.external.id],
        );
        count += rows.length;
      }
      return count;
    });
    console.log(`\nWrote ${inserted} link(s).`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
