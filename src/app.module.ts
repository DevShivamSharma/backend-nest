import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AccessModule } from './access/access.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './common/health/health.controller';
import { AppConfig, configuration } from './config/configuration';
import { Environment, validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { OrgSettingsModule } from './org-settings/org-settings.module';
import { OrganisationsModule } from './organisations/organisations.module';
import { TeamModule } from './team/team.module';
import { EventsModule } from './events/events.module';
import { RulesModule } from './rules/rules.module';
import { VenuesModule } from './venues/venues.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
      envFilePath: ['.env'],
      // The test bootstrap supplies its own isolated environment.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    // A broad per-client ceiling; sign-in and email routes set tighter limits of their own.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        skipIf: () => config.getOrThrow<AppConfig>('app').env === Environment.Test,
      }),
    }),
    DatabaseModule,
    AuthModule,
    OrganisationsModule,
    AccessModule,
    TeamModule,
    OrgSettingsModule,
    AdminModule,
    VenuesModule,
    RulesModule,
    EventsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
