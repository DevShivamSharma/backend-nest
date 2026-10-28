import { registerAs } from '@nestjs/config';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';

import validateConfig from '../utils/validate-config';
import { AppConfig } from './app-config.type';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariablesValidator {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment;

  @IsInt()
  @Min(0)
  @Max(65535)
  @IsOptional()
  APP_PORT: number;

  @IsUrl({ require_tld: false })
  @IsOptional()
  FRONTEND_DOMAIN: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  BACKEND_DOMAIN: string;

  @IsString()
  @IsOptional()
  API_PREFIX: string;

  /** Express's `trust proxy`: a hop count ("1"), true/false, or trusted addresses. */
  @IsString()
  @IsOptional()
  TRUST_PROXY: string;
}

/**
 * TRUST_PROXY as Express wants it: "true" / "false", a number of hops ("1"), or a name or list
 * of trusted addresses ("loopback, 10.0.0.0/8"). Left out: false.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const text = value?.trim();
  if (!text || text.toLowerCase() === 'false') return false;
  if (text.toLowerCase() === 'true') return true;
  return /^\d+$/.test(text) ? Number(text) : text;
}

export default registerAs<AppConfig>('app', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    name: process.env.APP_NAME || 'app',
    workingDirectory: process.env.PWD || process.cwd(),
    frontendDomain: process.env.FRONTEND_DOMAIN,
    backendDomain: process.env.BACKEND_DOMAIN ?? 'http://localhost',
    port: process.env.APP_PORT
      ? parseInt(process.env.APP_PORT, 10)
      : process.env.PORT
        ? parseInt(process.env.PORT, 10)
        : 3010,
    apiPrefix: process.env.API_PREFIX || 'ems/itpo/api',
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  };
});
