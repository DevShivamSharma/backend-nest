import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildDataSourceOptions } from './data-source-options';

/**
 * `migrations` is listed explicitly (see the file's own comment), which is deliberate but easy
 * to get wrong: adding a migration file without adding it to the array leaves the schema change
 * silently unapplied. The CLI then reports "No migrations are pending" and the next query fails
 * on the missing column. This test closes that gap.
 */
describe('buildDataSourceOptions', () => {
  const db = {
    ssl: false,
    host: 'localhost',
    port: 5432,
    name: 'd',
    user: 'u',
    password: 'p',
    poolSize: 1,
    connectionTimeoutMs: 1000,
    statementTimeoutMs: 1000,
    schema: 'idp',
    migrationsTable: 'planner_migrations',
  };

  it('keeps our tables in the configured schema, first on the search path, with our own history', () => {
    const options = buildDataSourceOptions(db) as {
      schema?: string;
      migrationsTableName?: string;
      extra?: { options?: string };
    };
    expect(options.schema).toBe('idp');
    expect(options.migrationsTableName).toBe('planner_migrations');
    expect(options.extra?.options).toBe('-c search_path=idp,public');
  });

  it('registers every migration file in the migrations directory', () => {
    const dir = join(__dirname, 'migrations');
    const onDisk = readdirSync(dir)
      .filter((f) => /\.ts$/.test(f) && !f.endsWith('.spec.ts'))
      // "1791100000000-PlatformFoundation.ts" -> "PlatformFoundation1791100000000"
      .map((f) => {
        const [timestamp, rest] = f.replace(/\.ts$/, '').split('-');
        return `${rest}${timestamp}`;
      })
      .sort();

    const options = buildDataSourceOptions(db);

    const registered = (options.migrations as Array<{ name: string }>).map((m) => m.name).sort();

    expect(registered).toEqual(onDisk);
  });
});
