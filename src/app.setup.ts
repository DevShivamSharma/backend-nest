import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { AppConfig } from './config/configuration';

/**
 * Everything that shapes HTTP behaviour, in one function, so `main.ts` and the end-to-end tests
 * configure the application identically.
 */
export function configureApp(app: INestApplication): AppConfig {
  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');

  // Routes become /api/layout/**, /api/layouts — matching the Java @RequestMapping values.
  // /health stays outside the migrated contract.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  // 500 normalized price rows exceed Express's default 100 kB body limit. Scope the larger
  // parser to this import, and wrap it so Nest still registers its default JSON parser elsewhere.
  const priceImportJson = json({ limit: '1mb' });
  app.use('/api/price-masters/import', (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => priceImportJson(req, res, next));

  // Type checking only. Business rules live in layout.validator.ts, because they must report
  // the FIRST failure in a specific order that decorators cannot express (ADR-010).
  // No implicit conversion: a JSON string where a number belongs is a 400, not a silent cast.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.useGlobalFilters(new AllExceptionsFilter());

  // Replaces @CrossOrigin(origins = "*") on all three Java controllers (S-01).
  // Credentials stay off: nothing authenticates.
  app.enableCors({
    origin: appConfig.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: false,
  });

  app.enableShutdownHooks();

  return appConfig;
}
