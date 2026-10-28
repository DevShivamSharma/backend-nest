import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';

import appConfig from './config/app.config';
import { AllConfigType } from './config/config.type';
import authConfig from './auth/config/auth.config';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import redisConfig from './common/redis-service/redis.config';
import databaseConfig from './database/config/database.config';
import { TypeOrmConfigService } from './database/typeorm-config.service';
import { EventsModule } from './events/events.module';
import { HallsModule } from './halls/halls.module';
import { RulesModule } from './rules/rules.module';
import { AuditModule } from './audit/audit.module';
import { MailModule } from './mail/mail.module';
import { CategoryMasterModule } from './category-master/category-master.module';
import { EmailRecipientsModule } from './email-recipients/email-recipients.module';
import { AiModule } from './ai/ai.module';
import { StallPlansModule } from './stall-plans/stall-plans.module';

const infrastructureDatabaseModule = TypeOrmModule.forRootAsync({
  useClass: TypeOrmConfigService,
  dataSourceFactory: async (options?: DataSourceOptions) => {
    return new DataSource(options as DataSourceOptions).initialize();
  },
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, appConfig, authConfig, redisConfig],
      envFilePath: ['.env'],
    }),
    // A broad per-client ceiling; the login route sets a tighter limit of its own.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        skipIf: () => configService.get('app.nodeEnv', { infer: true }) === 'test',
      }),
    }),
    infrastructureDatabaseModule,
    CommonModule,
    AuthModule,
    HallsModule,
    EventsModule,
    RulesModule,
    StallPlansModule,
    AiModule,
    AuditModule,
    MailModule,
    EmailRecipientsModule,
    CategoryMasterModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
