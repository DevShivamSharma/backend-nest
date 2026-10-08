import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
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

/** Where outgoing mail goes. Only `log` exists today: links are written to the server log. */
export enum MailTransport {
  Log = 'log',
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

  /**
   * Shared secret the venue's booking system signs status reports with. Unset: the callback is
   * off. At least 32 characters.
   */
  @IsString()
  @MinLength(32, { message: 'VENUE_SYSTEM_WEBHOOK_SECRET must be at least 32 characters' })
  @IsOptional()
  VENUE_SYSTEM_WEBHOOK_SECRET?: string;
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
