import { AuthConfig } from '../auth/config/auth-config.type';
import { RedisConfig } from '../common/redis-service/redis-config.type';
import { DatabaseConfig } from '../database/config/database-config.type';
import { AppConfig } from './app-config.type';

export type AllConfigType = {
  app: AppConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  redis: RedisConfig;
};
