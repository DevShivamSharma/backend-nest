import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

/**
 * Boot-time environment validation.
 *
 * The Java application had none: `application.properties` carried literal values, so a missing
 * or wrong setting surfaced as a connection failure at the first request rather than at startup
 * (docs/05-integrations.md). This fails loudly at boot instead, naming the offending variable.
 */
export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment, {
    message: 'NODE_ENV must be one of: development, production, test',
  })
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  /** Default 8080 matches the Java `server.port` so the frontend base URL keeps working. */
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 8080;

  /**
   * Full postgres:// connection string. Platforms with a managed database may inject
   * DATABASE_URL; Verdent reserves that name for platform use, so its project Secrets use
   * SUPABASE_DB_URL instead. When either is present, the discrete DATABASE_* settings below
   * are optional and ignored. Local development keeps using the discrete settings.
   */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  DATABASE_URL?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  SUPABASE_DB_URL?: string;

  /**
   * Whether the Postgres connection requires TLS. Managed databases require it, so it defaults
   * to true when a connection-string variable is set and false otherwise (see
   * configuration.ts). Set explicitly ('true'/'false') to override either default.
   */
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

  /**
   * Never logged, never echoed, never included in an error message. The validator below reports
   * only property names, never values, precisely so a malformed password cannot leak into logs.
   */
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

  /**
   * Comma-separated allow-list. Replaces the Java `@CrossOrigin(origins = "*")` that sat on all
   * three controllers (docs/06-authentication.md S-01). Defaults to the CRA dev server.
   */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  CORS_ORIGINS: string = 'http://localhost:3000';

  /** Upper bound on the `stalls` array, closing the unbounded-request risk (R-07). */
  @IsInt()
  @Min(1)
  @IsOptional()
  MAX_STALLS_PER_LAYOUT: number = 2000;
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
    // Report property names and constraint text only — never the offending value, which could
    // be a credential.
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
