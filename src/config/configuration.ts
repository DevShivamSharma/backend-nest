import { Environment } from './env.validation';

export interface AppConfig {
  env: Environment;
  port: number;
  corsOrigins: string[];
}

export interface DatabaseConfig {
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
