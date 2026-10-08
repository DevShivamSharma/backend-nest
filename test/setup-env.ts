import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * End-to-end tests run against a REAL PostgreSQL, but never the development database:
 * credentials come from .env, and the database name is forced to the dedicated test database,
 * which every suite wipes. Values already in process.env win over the .env file.
 */
for (const [key, value] of Object.entries(
  parseEnv(readFileSync(join(__dirname, '..', '.env'), 'utf8')),
)) {
  process.env[key] ??= value;
}

process.env.NODE_ENV = 'test';
// Runs side by side may each use their own test database — never one without the test prefix.
const testDatabase = process.env.E2E_DATABASE_NAME ?? 'venue_platform_test';
if (!/^venue_platform_test\w*$/.test(testDatabase)) {
  throw new Error('E2E_DATABASE_NAME must start with venue_platform_test.');
}
process.env.DATABASE_NAME = testDatabase;
process.env.CORS_ORIGINS = 'http://localhost:4200';
process.env.APP_PUBLIC_URL = 'http://localhost:4200';
process.env.MAIL_TRANSPORT = 'log';
process.env.JWT_ACCESS_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e';
// Turns the venue-system status callback on, so its signature checks are tested.
process.env.VENUE_SYSTEM_WEBHOOK_SECRET ??= 'e2e-venue-secret-e2e-venue-secret-e2e';

// URL mode takes precedence over DATABASE_NAME: never allow tests onto a managed database.
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_DB_URL;
process.env.DATABASE_SSL = 'false';
if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DATABASE_HOST ?? '')) {
  throw new Error('Integration tests require a local PostgreSQL host.');
}
