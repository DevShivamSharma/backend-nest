import {
  AiProvider,
  Environment,
  MailTransport,
  PaymentsTransport,
  VenueCallbackTransport,
} from './env.validation';

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
  /**
   * The schema our tables live in, first on the search path. `idp` on ITPO's database, where
   * ITPO's own tables are; `public` on a database of our own.
   */
  schema: string;
  /** Our migrations' history table; apart from ITPO's own `migrations`. */
  migrationsTable: string;
}

/** Who signs in: ITPO's own users (T_USER), or our own accounts (tests, local work). */
export interface ItpoConfig {
  /** `itpo`: sign-in checks ITPO's T_USER; `local`: our own accounts. */
  authSource: 'itpo' | 'local';
  /** Our organisation that stands for ITPO; made on the first ITPO sign-in. */
  orgSlug: string;
  orgName: string;
  /** T_CODE_MASTER role slugs that sign in as ITPO admins (all else but organisers is refused). */
  adminRoles: string[];
}

export interface AuthConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
  /** Accounts the local quick-login page may sign in as; always empty in production. */
  devLoginEmails: string[];
}

export interface MailConfig {
  transport: MailTransport;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    password: string | null;
    from: string;
  } | null;
  /** Outside production, where every email goes instead; empty to send as addressed. */
  redirectTo: string[];
}

export interface BookingsConfig {
  /** Minutes a hold lasts before it expires, unless confirmed. */
  holdMinutes: number;
}

export interface PaymentsConfig {
  transport: PaymentsTransport;
  /** Set only with the razorpay transport. Never logged. */
  razorpay: { keyId: string; keySecret: string } | null;
  /** Verifies the webhook's signature; null leaves the webhook route off. */
  webhookSecret: string | null;
}

export interface VenueSystemConfig {
  transport: VenueCallbackTransport;
  timeoutMs: number;
  /** The 32-byte key that seals venue secrets; null when unset. Never logged. */
  secretKey: Buffer | null;
}

/** One model the assistant may use. */
export interface AiModelConfig {
  provider: AiProvider;
  /** Gemini, Groq or NVIDIA key; null for Ollama. */
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
  itpo: ItpoConfig;
  mail: MailConfig;
  bookings: BookingsConfig;
  payments: PaymentsConfig;
  venueSystem: VenueSystemConfig;
  ai: AiConfig;
}

/** The model each provider uses when AI_MODEL (or LLM_TEXT_MODEL for Ollama) is not set. */
const DEFAULT_MODELS: Record<AiProvider, string> = {
  [AiProvider.Gemini]: 'gemini-3.8-flash',
  [AiProvider.Groq]: 'openai/gpt-oss-120b',
  [AiProvider.Nvidia]: 'nvidia/nemotron-3-ultra-550b-a55b',
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
      schema: env.DATABASE_SCHEMA ?? 'public',
      migrationsTable: env.DATABASE_MIGRATIONS_TABLE ?? 'migrations',
    },
    itpo: {
      authSource: env.AUTH_SOURCE === 'itpo' ? 'itpo' : 'local',
      orgSlug: env.ITPO_ORG_SLUG ?? 'itpo',
      orgName: env.ITPO_ORG_NAME ?? 'ITPO',
      adminRoles: (
        env.ITPO_ADMIN_ROLES ??
        'system_admin,itpo_admin,stall_admin,stall_admin_chennai,stall_architecture,architect'
      )
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET as string,
      accessTtlSeconds: Number(env.JWT_ACCESS_TTL_SECONDS ?? 900),
      refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 14),
      cookieSecure:
        env.COOKIE_SECURE !== undefined
          ? env.COOKIE_SECURE === 'true'
          : nodeEnv === Environment.Production,
      devLoginEmails:
        nodeEnv === Environment.Production
          ? []
          : (env.DEV_LOGIN_EMAILS ?? '')
              .split(',')
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean),
    },
    mail: {
      transport: (env.MAIL_TRANSPORT as MailTransport) ?? MailTransport.Log,
      smtp:
        env.MAIL_TRANSPORT === MailTransport.Smtp
          ? {
              host: env.SMTP_HOST_NAME ?? '',
              port: Number(env.SMTP_PORT ?? 465),
              secure: env.SMTP_SECURE !== 'false',
              user: env.SMTP_AUTH_USER || null,
              password: env.SMTP_AUTH_PASSWORD || null,
              from: env.SMTP_FROM_EMAIL ?? '',
            }
          : null,
      redirectTo:
        nodeEnv === Environment.Production
          ? []
          : (env.MAIL_REDIRECT_TO ?? '')
              .split(',')
              .map((a) => a.trim())
              .filter(Boolean),
    },
    bookings: { holdMinutes: Number(env.BOOKING_HOLD_MINUTES ?? 60) },
    payments: {
      transport: (env.PAYMENTS_TRANSPORT as PaymentsTransport) ?? PaymentsTransport.Log,
      razorpay:
        env.PAYMENTS_TRANSPORT === PaymentsTransport.Razorpay
          ? {
              keyId: env.RAZORPAY_KEY_ID as string,
              keySecret: env.RAZORPAY_KEY_SECRET as string,
            }
          : null,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET?.trim() || null,
    },
    venueSystem: {
      transport:
        (env.VENUE_CALLBACK_TRANSPORT as VenueCallbackTransport) ?? VenueCallbackTransport.Log,
      timeoutMs: Number(env.VENUE_CALLBACK_TIMEOUT_MS ?? 10_000),
      secretKey: env.INTEGRATION_SECRET_KEY
        ? Buffer.from(env.INTEGRATION_SECRET_KEY, 'base64')
        : null,
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
    const prefix =
      provider === AiProvider.Groq ? 'GROQ' : provider === AiProvider.Nvidia ? 'NVIDIA' : 'GEMINI';
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
