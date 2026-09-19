import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthController } from './common/health/health.controller';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { LayoutsModule } from './layouts/layouts.module';

/** Root composition. HallsModule (/api/halls, no known consumer) is post-demo work. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    DatabaseModule,
    LayoutsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
