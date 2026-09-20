import { Environment } from './env.validation';

export interface AppConfig {
  env: Environment;
  port: number;
  corsOrigins: string[];
}

export interface DatabaseConfig {
  /** Full postgres:// connection string. When set, the discrete fields below are ignored. */
  url?: string;
  /** TLS required (managed databases). Defaults to true in URL mode, false otherwise. */
  ssl: boolean;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  poolSize: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface LimitsConfig {
  maxStallsPerLayout: number;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  limits: LimitsConfig;
}

/**
 * Builds the typed configuration tree from the already-validated environment.
 *
 * `validateEnv` has run by the time this executes, so every value here is known-good and the
 * casts are safe.
 */
export function configuration(): Configuration {
  const env = process.env;

  return {
    app: {
      env: (env.NODE_ENV as Environment) ?? Environment.Development,
      port: Number(env.PORT ?? 8080),
      corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:3000')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    database: {
      // The configured project secret wins: Verdent injects its own DATABASE_URL at runtime,
      // which does not point at the project's managed Postgres.
      url: env.SUPABASE_DB_URL ?? env.DATABASE_URL,
      ssl:
        env.DATABASE_SSL !== undefined
          ? env.DATABASE_SSL === 'true'
          : Boolean(env.SUPABASE_DB_URL ?? env.DATABASE_URL),
      host: env.DATABASE_HOST as string,
      port: Number(env.DATABASE_PORT ?? 5432),
      name: env.DATABASE_NAME as string,
      user: env.DATABASE_USER as string,
      password: env.DATABASE_PASSWORD as string,
      poolSize: Number(env.DATABASE_POOL_SIZE ?? 10),
      connectionTimeoutMs: Number(env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10_000),
      statementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000),
    },
    limits: {
      maxStallsPerLayout: Number(env.MAX_STALLS_PER_LAYOUT ?? 2000),
    },
  };
}
