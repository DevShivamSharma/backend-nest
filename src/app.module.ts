import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthController } from './common/health/health.controller';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HallsModule } from './halls/halls.module';
import { LayoutsModule } from './layouts/layouts.module';
import { AssistModule } from './layouts/assist/assist.module';

/** Root composition. HallsModule serves /api/halls: ported but deprecated, no known consumer (ADR-002). */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
      envFilePath: ['.env'],
      // Test bootstrap supplies a local, isolated environment; never reload production URLs.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    DatabaseModule,
    LayoutsModule,
    HallsModule,
    AssistModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
