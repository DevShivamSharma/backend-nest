import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

/**
 * End-to-end tests run against a REAL PostgreSQL, but never the development database:
 * credentials come from .env, and the database name is forced to the dedicated test database.
 * Values already in process.env win over the .env file, so the override below sticks.
 */
for (const [key, value] of Object.entries(
  parseEnv(readFileSync(join(__dirname, '..', '.env'), 'utf8')),
)) {
  process.env[key] ??= value;
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = 'stall_designer_test';
process.env.CORS_ORIGINS = 'http://localhost:4200';

// URL mode takes precedence over DATABASE_NAME: never allow tests onto a managed database.
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_DB_URL;
process.env.DATABASE_SSL = 'false';
if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DATABASE_HOST ?? '')) {
  throw new Error('Integration tests require a local PostgreSQL host.');
}
