import { Environment, MailTransport } from './env.validation';

export interface AppConfig {
  env: Environment;
  port: number;
  corsOrigins: string[];
  /** Base URL of the web app, without a trailing slash. */
  publicUrl: string;
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

export interface AuthConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
}

export interface MailConfig {
  transport: MailTransport;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  mail: MailConfig;
}

/**
 * Builds the typed configuration tree from the already-validated environment.
 *
 * `validateEnv` has run by the time this executes, so every value here is known-good and the
 * casts are safe.
 */
export function configuration(): Configuration {
  const env = process.env;
  const nodeEnv = (env.NODE_ENV as Environment) ?? Environment.Development;

  return {
    app: {
      env: nodeEnv,
      port: Number(env.PORT ?? 8080),
      corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:4200')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      publicUrl: (env.APP_PUBLIC_URL ?? 'http://localhost:4200').replace(/\/+$/, ''),
    },
    database: {
      // The configured project secret wins over a platform-injected DATABASE_URL.
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
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET as string,
      accessTtlSeconds: Number(env.JWT_ACCESS_TTL_SECONDS ?? 900),
      refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 14),
      cookieSecure:
        env.COOKIE_SECURE !== undefined
          ? env.COOKIE_SECURE === 'true'
          : nodeEnv === Environment.Production,
    },
    mail: {
      transport: (env.MAIL_TRANSPORT as MailTransport) ?? MailTransport.Log,
    },
  };
}
