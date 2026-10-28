import { registerAs } from '@nestjs/config';
import { IsString, Matches, MinLength } from 'class-validator';

import validateConfig from '../../utils/validate-config';
import { AuthConfig } from './auth-config.type';

class EnvironmentVariablesValidator {
  /** Signs the access tokens; the same secret ITPO's own apps use. */
  @IsString()
  @MinLength(32)
  AUTH_JWT_SECRET: string;

  /** Token lifetime in ITPO's format, e.g. "240m". */
  @IsString()
  @Matches(/^\d+[smhd]$/)
  AUTH_JWT_TOKEN_EXPIRES_IN: string;

  @IsString()
  @MinLength(32)
  AUTH_REFRESH_SECRET: string;

  @IsString()
  @Matches(/^\d+[smhd]$/)
  AUTH_REFRESH_TOKEN_EXPIRES_IN: string;
}

export default registerAs<AuthConfig>('auth', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    secret: process.env.AUTH_JWT_SECRET,
    expires: process.env.AUTH_JWT_TOKEN_EXPIRES_IN,
    refreshSecret: process.env.AUTH_REFRESH_SECRET,
    refreshExpires: process.env.AUTH_REFRESH_TOKEN_EXPIRES_IN,
  };
});
