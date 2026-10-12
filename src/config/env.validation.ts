import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

/**
 * Boot-time environment validation. A missing or malformed variable aborts startup with a
 * message naming it, rather than surfacing as a failure at the first request.
 */
export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** Which model answers the planner's AI assistant: Gemini's or Groq's API, or a local Ollama. */
export enum AiProvider {
  Gemini = 'gemini',
  Groq = 'groq',
  Ollama = 'ollama',
}

/** Where outgoing mail goes: the server log (links for a developer), or an SMTP server. */
export enum MailTransport {
  Log = 'log',
  Smtp = 'smtp',
}

/** Where payments go: nowhere real (fake orders; a dev route marks them paid), or Razorpay. */
export enum PaymentsTransport {
  Log = 'log',
  Razorpay = 'razorpay',
}

export class EnvironmentVariables {
  @IsEnum(Environment, {
    message: 'NODE_ENV must be one of: development, production, test',
  })
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 8080;

  /**
   * Full postgres:// connection string. When set, the discrete DATABASE_* settings below are
   * optional and ignored. SUPABASE_DB_URL exists for platforms that reserve DATABASE_URL.
   */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  DATABASE_URL?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  SUPABASE_DB_URL?: string;

  /** TLS for the database. Defaults to true when a connection string is set, else false. */
  @IsBoolean()
  @IsOptional()
  DATABASE_SSL?: boolean;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL && !o.SUPABASE_DB_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_HOST?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  DATABASE_PORT: number = 5432;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL && !o.SUPABASE_DB_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_NAME?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL && !o.SUPABASE_DB_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_USER?: string;

  /** Never logged or echoed: the validator below reports property names only. */
  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL && !o.SUPABASE_DB_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD?: string;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  DATABASE_POOL_SIZE: number = 10;

  @IsInt()
  @Min(1000)
  @IsOptional()
  DATABASE_CONNECTION_TIMEOUT_MS: number = 10_000;

  @IsInt()
  @Min(1000)
  @IsOptional()
  DATABASE_STATEMENT_TIMEOUT_MS: number = 15_000;

  /** Comma-separated origin allow-list for the browser app. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  CORS_ORIGINS: string = 'http://localhost:4200';

  /** Base URL of the web app, used to build links in invitation and reset emails. */
  @IsUrl({ require_tld: false, require_protocol: true })
  @IsOptional()
  APP_PUBLIC_URL: string = 'http://localhost:4200';

  /** HMAC secret for access tokens. At least 32 characters; rotating it signs everyone out. */
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsInt()
  @Min(60)
  @Max(3600)
  @IsOptional()
  JWT_ACCESS_TTL_SECONDS: number = 900;

  @IsInt()
  @Min(1)
  @Max(90)
  @IsOptional()
  REFRESH_TOKEN_TTL_DAYS: number = 14;

  /** Secure flag on the refresh cookie. Defaults to true in production. */
  @IsBoolean()
  @IsOptional()
  COOKIE_SECURE?: boolean;

  @IsEnum(MailTransport)
  @IsOptional()
  MAIL_TRANSPORT: MailTransport = MailTransport.Log;

  /** The SMTP server, with MAIL_TRANSPORT=smtp; the same names ITPO's admin service uses. */
  @ValidateIf((env: EnvironmentVariables) => env.MAIL_TRANSPORT === MailTransport.Smtp)
  @IsString()
  @IsNotEmpty({ message: 'SMTP_HOST_NAME is required when MAIL_TRANSPORT=smtp' })
  SMTP_HOST_NAME?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  SMTP_PORT: number = 465;

  /** TLS from the start (port 465); false for STARTTLS on 587. Defaults to true. */
  @IsBoolean()
  @IsOptional()
  SMTP_SECURE?: boolean;

  @IsString()
  @IsOptional()
  SMTP_AUTH_USER?: string;

  @IsString()
  @IsOptional()
  SMTP_AUTH_PASSWORD?: string;

  @ValidateIf((env: EnvironmentVariables) => env.MAIL_TRANSPORT === MailTransport.Smtp)
  @IsString()
  @IsNotEmpty({ message: 'SMTP_FROM_EMAIL is required when MAIL_TRANSPORT=smtp' })
  SMTP_FROM_EMAIL?: string;

  /**
   * Outside production, every email goes to these addresses (comma separated) instead of its
   * own, so testing never mails real people. Empty: emails go where they are addressed.
   */
  @IsString()
  @IsOptional()
  MAIL_REDIRECT_TO?: string;

  /**
   * Minutes a held stall stays held unless confirmed (docs/15 §9 Q11, SelfCare's 60). At most a
   * week, so a forgotten hold cannot keep a stall off sale for the whole event.
   */
  @IsInt()
  @Min(1)
  @Max(10_080)
  @IsOptional()
  BOOKING_HOLD_MINUTES: number = 60;

  @IsEnum(PaymentsTransport, { message: 'PAYMENTS_TRANSPORT must be one of: log, razorpay' })
  @IsOptional()
  PAYMENTS_TRANSPORT: PaymentsTransport = PaymentsTransport.Log;

  /** Razorpay key id (rzp_test_… or rzp_live_…), with PAYMENTS_TRANSPORT=razorpay. */
  @ValidateIf((env: EnvironmentVariables) => env.PAYMENTS_TRANSPORT === PaymentsTransport.Razorpay)
  @Matches(/^rzp_(test|live)_\w+$/, {
    message: 'RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…',
  })
  RAZORPAY_KEY_ID?: string;

  /** Never logged or echoed. */
  @ValidateIf((env: EnvironmentVariables) => env.PAYMENTS_TRANSPORT === PaymentsTransport.Razorpay)
  @IsString()
  @IsNotEmpty({ message: 'RAZORPAY_KEY_SECRET is required when PAYMENTS_TRANSPORT=razorpay' })
  RAZORPAY_KEY_SECRET?: string;

  /** The webhook's secret from the Razorpay dashboard. Unset: the webhook route answers 404. */
  @IsString()
  @IsOptional()
  RAZORPAY_WEBHOOK_SECRET?: string;

  @IsEnum(AiProvider, { message: 'AI_PROVIDER must be one of: gemini, groq, ollama' })
  @IsOptional()
  AI_PROVIDER: AiProvider = AiProvider.Gemini;

  /**
   * Providers to try in order when one fails or is rate-limited, e.g. "groq,gemini,ollama".
   * Without it, only AI_PROVIDER.
   */
  @Matches(/^\s*(gemini|groq|ollama)\s*(,\s*(gemini|groq|ollama)\s*)*$/i, {
    message: 'AI_PROVIDERS must list gemini, groq or ollama, separated by commas',
  })
  @IsOptional()
  AI_PROVIDERS?: string;

  /** Groq's key and model, for AI_PROVIDERS. Never logged. */
  @IsString()
  @IsOptional()
  GROQ_API_KEY?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  GROQ_MODEL?: string;

  /** Gemini's key and model, for AI_PROVIDERS. Never logged. */
  @IsString()
  @IsOptional()
  GEMINI_API_KEY?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  GEMINI_MODEL?: string;

  /** Gemini or Groq API key. Without it the assistant says it is not set up. Never logged. */
  @IsString()
  @IsOptional()
  AI_API_KEY?: string;

  /** The Gemini or Groq model. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  AI_MODEL?: string;

  /** Ollama's address, e.g. http://localhost:11434. */
  @IsUrl({ require_tld: false, require_protocol: true })
  @IsOptional()
  LLM_BASE_URL?: string;

  /** The Ollama model, e.g. qwen3:4b. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  LLM_TEXT_MODEL?: string;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    // Property names and constraint text only — never the offending value, which could be a
    // credential.
    const detail = errors
      .map((error) => {
        const reasons = Object.values(error.constraints ?? {}).join('; ');
        return `  - ${error.property}: ${reasons || 'is invalid'}`;
      })
      .join('\n');

    throw new Error(
      `Invalid environment configuration. Fix the following and restart:\n${detail}\n` +
        `See backend-nest/.env.example for the full list of variables.`,
    );
  }

  return validated;
}
