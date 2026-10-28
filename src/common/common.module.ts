import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { HealthController } from './health/health.controller';
import { AllConfigType } from '../config/config.type';
import { RedisService } from './redis-service/redis.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    RedisService,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AllConfigType>) => {
        const redis = configService.getOrThrow('redis', { infer: true });
        return new Redis({
          host: redis.host,
          port: redis.port,
          password: redis.password,
          connectTimeout: 10_000,
        });
      },
    },
  ],
  exports: [RedisService],
})
export class CommonModule {}
