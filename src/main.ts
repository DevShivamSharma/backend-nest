import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const appConfig = configureApp(app);

  await app.listen(appConfig.port);

  logger.log(`Listening on port ${appConfig.port} (env: ${appConfig.env})`);
  logger.log(`CORS allow-list: ${appConfig.corsOrigins.join(', ')}`);
}

void bootstrap();
