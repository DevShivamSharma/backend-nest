import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';

/** Bundles named by their content (Angular `outputHashing: all`), e.g. `chunk-U66EIYBT.js`. */
const HASHED_BUNDLE = /-[A-Z0-9]{8}\.(?:js|css)$/;

const isBuildRequest = (req: Request): boolean =>
  (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') && !req.path.startsWith('/health');

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

  // Hashed bundles and versioned assets (`?v=…`) change URL when they change, so browsers keep them
  // a year without asking; everything else, the venue models included, is revalidated by ETag.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isBuildRequest(req)) {
      // Plain and gzipped copies share a URL, so caches must key them by Accept-Encoding.
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', HASHED_BUNDLE.test(req.path) || typeof req.query['v'] === 'string'
        ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    }
    next();
  });

  // The Dockerfile writes a gzipped copy beside each model, JSON and bundle (`name.gz`); browsers
  // that accept gzip get that copy, about half the bytes for the venue models.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isBuildRequest(req) || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      next();
      return;
    }
    let file: string;
    try {
      file = join(publicDir, decodeURIComponent(req.path));
    } catch {
      next();
      return;
    }
    if (!file.startsWith(publicDir + sep) || !existsSync(`${file}.gz`)) {
      next();
      return;
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.type(extname(file));
    res.sendFile(`${file}.gz`, (error?: Error) => {
      if (error) next(error);
    });
  });

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
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const appConfig = configureApp(app);

  serveAngularBuild(app.getHttpAdapter().getInstance() as Express);

  await app.listen(appConfig.port);

  logger.log(`Listening on port ${appConfig.port} (env: ${appConfig.env})`);
  logger.log(`CORS allow-list: ${appConfig.corsOrigins.join(', ')}`);
}

void bootstrap();
