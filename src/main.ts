import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';

/**
 * Serves the Angular production build from ./public when it exists (the published single-
 * container deployment). Local `nest start` works unchanged without it: the guard skips
 * registration and the SPA keeps running on the Angular dev server.
 */
function serveAngularBuild(app: Express): void {
  const publicDir = join(__dirname, '..', 'public');
  if (!existsSync(join(publicDir, 'index.html'))) {
    return;
  }

  app.use(express.static(publicDir));

  // SPA fallback: Angular owns every GET outside the API and health contracts.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
      res.sendFile(join(publicDir, 'index.html'));
      return;
    }
    next();
  });
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // rawBody: the venue system's status reports are signed over the exact bytes it sent.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const appConfig = configureApp(app);

  serveAngularBuild(app.getHttpAdapter().getInstance() as Express);

  await app.listen(appConfig.port);

  logger.log(`Listening on port ${appConfig.port} (env: ${appConfig.env})`);
  logger.log(`CORS allow-list: ${appConfig.corsOrigins.join(', ')}`);
}

void bootstrap();
