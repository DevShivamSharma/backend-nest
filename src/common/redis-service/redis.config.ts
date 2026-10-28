import { registerAs } from '@nestjs/config';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import validateConfig from '../../utils/validate-config';
import { RedisConfig } from './redis-config.type';

class EnvironmentVariablesValidator {
  @IsString()
  REDIS_HOST: string;

  @IsInt()
  @Min(0)
  @Max(65535)
  @IsOptional()
  REDIS_PORT: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD: string;
}

/**
 * The Redis ITPO's own apps keep their sessions in. They honour a token only while the session
 * and roles keys written here are in place, so signing in here writes them.
 */
export default registerAs<RedisConfig>('redis', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    host: process.env.REDIS_HOST as string,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  };
});
