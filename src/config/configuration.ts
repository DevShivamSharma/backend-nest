import { AiProvider, Environment, MailTransport } from './env.validation';

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

/** One model the assistant may use. */
export interface AiModelConfig {
  provider: AiProvider;
  /** Gemini or Groq key; null for Ollama. */
  apiKey: string | null;
  model: string;
  /** Ollama's address, without a trailing slash. */
  baseUrl: string;
}

export interface AiConfig {
  /** Tried in this order: when one fails or is rate-limited, the next answers. */
  chain: AiModelConfig[];
  /** Providers asked for that cannot be used, e.g. no key; reported at start-up. */
  skipped: string[];
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  mail: MailConfig;
  ai: AiConfig;
}

/** The model each provider uses when AI_MODEL (or LLM_TEXT_MODEL for Ollama) is not set. */
const DEFAULT_MODELS: Record<AiProvider, string> = {
  [AiProvider.Gemini]: 'gemini-3.8-flash',
  [AiProvider.Groq]: 'openai/gpt-oss-120b',
  [AiProvider.Ollama]: 'qwen3:4b',
};

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
    ai: aiConfig(env),
  };
}

/**
 * The assistant's models, in the order AI_PROVIDERS gives (e.g. "groq,gemini,ollama"), or just
 * AI_PROVIDER. Each provider takes its own key and model (GROQ_API_KEY, GEMINI_MODEL…); the first
 * one asked for may use AI_API_KEY and AI_MODEL instead. A cloud provider without a key is
 * skipped.
 */
function aiConfig(env: NodeJS.ProcessEnv): AiConfig {
  const primary = (env.AI_PROVIDER as AiProvider) ?? AiProvider.Gemini;
  const order = (env.AI_PROVIDERS ?? primary)
    .split(',')
    .map((p) => p.trim().toLowerCase() as AiProvider)
    .filter((p, i, all) => p && all.indexOf(p) === i);
  const first = order[0];
  const baseUrl = (env.LLM_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const chain: AiModelConfig[] = [];
  const skipped: string[] = [];
  for (const provider of order) {
    if (provider === AiProvider.Ollama) {
      const model = env.LLM_TEXT_MODEL?.trim() || DEFAULT_MODELS[provider];
      chain.push({ provider, apiKey: null, model, baseUrl });
      continue;
    }
    const prefix = provider === AiProvider.Groq ? 'GROQ' : 'GEMINI';
    const own = (name: string) => env[`${prefix}_${name}`]?.trim();
    const shared = (name: string) => (provider === first ? env[`AI_${name}`]?.trim() : undefined);
    const apiKey = own('API_KEY') || shared('API_KEY') || null;
    if (!apiKey) {
      skipped.push(`${provider} (no ${prefix}_API_KEY)`);
      continue;
    }
    const model = own('MODEL') || shared('MODEL') || DEFAULT_MODELS[provider];
    chain.push({ provider, apiKey, model, baseUrl });
  }
  return { chain, skipped };
}
