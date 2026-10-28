import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Stores a value, expiring after `ttlSeconds` when given. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
