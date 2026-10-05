import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { configuration } from '../src/config/configuration';
import { buildDataSourceOptions } from '../src/database/data-source-options';
import { PriceMasterEntity } from '../src/pricing/price-master.entity';
import { buildPricingLibrary, parseCopyTables, sourceMaster, type SourceRate } from '../src/pricing/pricing-library';

async function main() {
  const dumpPath = process.argv.find(a => a.startsWith('--dump='))?.slice(7);
  if (!dumpPath) throw new Error('Supply --dump=<path> and optionally --apply. Preview is the default.');
  const bytes = readFileSync(dumpPath);
  if (bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Expected a PostgreSQL custom-format dump');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const tables = ['T_STALL_PRICE_MASTER', 'T_EVENT_HALL', 'T_HALL_BOOKING', 'T_HALLS_PRICE', 'T_HALLS_CATEGORY', 'T_HALLS'];
  const sql = execFileSync(process.env.PG_RESTORE_PATH || 'pg_restore', ['--data-only', ...tables.map(t => `--table=${t}`), '--file=-', dumpPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const catalog = buildPricingLibrary(parseCopyTables(sql));
  const candidates = catalog.stallRates.map(rate => ({ rate, master: sourceMaster(rate) })).filter(r => r.master !== null);
  if (new Set(candidates.map(c => c.master!.name.toLowerCase())).size !== candidates.length) throw new Error('Duplicate generated names');
  const summary = { stallRates: catalog.stallRates.length, events: new Set(catalog.stallRates.map(r => r.eventId)).size,
    mappedStallLocations: new Set(catalog.stallRates.filter(r => r.venueHallId).map(r => r.venueHallId)).size,
    editableMasters: candidates.length, referenceOnly: catalog.stallRates.length - candidates.length,
    hallLocations: catalog.hallRentals.length, rentalSchedules: catalog.schedules.length };
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ mode: 'preview', ...summary })); return; }
  const config = configuration().database;
  const host = config.url ? new URL(config.url).hostname : config.host;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('Demo import is restricted to the local database');
  const db = new DataSource(buildDataSourceOptions(config));
  await db.initialize();
  try {
    const result = await db.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [1791040000]);
      const previous = (await manager.query('SELECT catalog FROM pricing_libraries WHERE id = $1', ['p-db-demo']))[0]?.catalog;
      const priorRows: SourceRate[] = previous?.stallRates ?? [];
      let created = 0, retained = 0;
      for (const { rate, master } of candidates) {
        const old = priorRows.find(r => r.id === rate.id);
        const existing = old?.masterId ? await manager.findOneBy(PriceMasterEntity, { id: old.masterId }) : null;
        if (existing) { rate.masterId = existing.id; rate.masterName = existing.name; retained++; continue; }
        const { name, ...policy } = master!;
        // A same-named user master is a conflict, never permission to overwrite it.
        if (await manager.query('SELECT id FROM price_masters WHERE lower(name) = lower($1)', [name]).then(rows => rows.length)) throw new Error(`Name already exists: ${name}`);
        const saved = await manager.save(manager.create(PriceMasterEntity, { name, policy }));
        rate.masterId = saved.id; rate.masterName = saved.name; created++;
      }
      await manager.query(`INSERT INTO pricing_libraries(id, source_hash, catalog) VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET source_hash = EXCLUDED.source_hash, catalog = EXCLUDED.catalog, imported_at = now()`,
      ['p-db-demo', sourceHash, JSON.stringify(catalog)]);
      return { created, retained };
    });
    writeFileSync('scripts/data/pricing-library-import-result.json', JSON.stringify({ ...summary, ...result, sourceHash }, null, 2));
    console.log(JSON.stringify({ mode: 'saved', ...summary, ...result }));
  } finally { await db.destroy(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
