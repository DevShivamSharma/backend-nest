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

    const options = buildDataSourceOptions({
      ssl: false,
      host: 'localhost',
      port: 5432,
      name: 'd',
      user: 'u',
      password: 'p',
      poolSize: 1,
      connectionTimeoutMs: 1000,
      statementTimeoutMs: 1000,
    });

    const registered = (options.migrations as Array<{ name: string }>).map((m) => m.name).sort();

    expect(registered).toEqual(onDisk);
  });
});
