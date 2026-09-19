import { join } from 'node:path';

/**
 * End-to-end tests run against a REAL PostgreSQL, but never the development database:
 * credentials come from .env, and the database name is forced to the dedicated test database.
 * Values already in process.env win over the .env file, so the override below sticks.
 */
process.loadEnvFile(join(__dirname, '..', '.env'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME = 'stall_designer_test';
process.env.CORS_ORIGINS = 'http://localhost:4200';
