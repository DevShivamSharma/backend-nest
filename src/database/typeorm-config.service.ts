import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { types } from 'pg';

import { AllConfigType } from '../config/config.type';

// The pg driver returns int8 (COUNT(*)) as a string by default. Counts here are far below
// Number.MAX_SAFE_INTEGER, so parsing to a JS number is safe.
types.setTypeParser(types.builtins.INT8, (value: string) => parseInt(value, 10));
// A calendar date stays the text it is ("2026-08-10"), never a Date shifted by a time zone.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

@Injectable()
export class TypeOrmConfigService implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService<AllConfigType>) {}

  createTypeOrmOptions(): TypeOrmModuleOptions {
    return {
      type: this.configService.get('database.type', { infer: true }),
      url: this.configService.get('database.url', { infer: true }),
      host: this.configService.get('database.host', { infer: true }),
      port: this.configService.get('database.port', { infer: true }),
      username: this.configService.get('database.username', { infer: true }),
      password: this.configService.get('database.password', { infer: true }),
      database: this.configService.get('database.name', { infer: true }),
      synchronize: this.configService.get('database.synchronize', { infer: true }),
      autoLoadEntities: true,
      // Ids made by the database itself: gen_random_uuid(), no extension to install.
      uuidExtension: 'pgcrypto',
      dropSchema: false,
      keepConnectionAlive: true,
      logging: this.configService.get('app.nodeEnv', { infer: true }) !== 'production',
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/migrations/**/*{.ts,.js}'],
      extra: {
        // based on https://node-postgres.com/apis/pool
        // max connection pool size
        max: this.configService.get('database.maxConnections', { infer: true }),
        ssl: this.configService.get('database.sslEnabled', { infer: true })
          ? {
              rejectUnauthorized: this.configService.get('database.rejectUnauthorized', {
                infer: true,
              }),
              ca: this.configService.get('database.ca', { infer: true }) ?? undefined,
              key: this.configService.get('database.key', { infer: true }) ?? undefined,
              cert: this.configService.get('database.cert', { infer: true }) ?? undefined,
            }
          : undefined,
      },
    } as TypeOrmModuleOptions;
  }
}
