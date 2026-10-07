import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { AppConfig } from './config/configuration';

/**
 * Everything that shapes HTTP behaviour, in one function, so `main.ts` and the end-to-end tests
 * configure the application identically.
 */
export function configureApp(app: INestApplication): AppConfig {
  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');

  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Organisation logos are https URLs anywhere; fonts come from Google Fonts.
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Hall floors and their imports are whole documents: ITPO's export of every hall is ~2 MB.
  (app as NestExpressApplication).useBodyParser('json', { limit: '15mb' });

  // Reads the httpOnly refresh-token cookie.
  app.use(cookieParser());

  // whitelist + forbidNonWhitelisted: unknown fields are a 400, never silently stored.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Credentials on: the browser sends the refresh cookie to /api/auth/refresh.
  app.enableCors({
    origin: appConfig.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.enableShutdownHooks();

  return appConfig;
}
