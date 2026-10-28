import 'dotenv/config';
import 'reflect-metadata';

import { ClassSerializerInterceptor, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception/global-exception.filter';
import { TrimPipe } from './common/pipes/trim-string.pipe';
import { AllConfigType } from './config/config.type';
import { ResponseInterceptor } from './response/response.interceptor';
import { SwaggerAuthMiddleware } from './SwaggerAuthMiddleware';
import { ResolvePromisesInterceptor } from './utils/serializer.interceptor';
import validationOptions from './utils/validation-options';

async function bootstrap() {
  // No CORS for now: the web app reaches the API through its dev proxy / the same origin.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false });
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  const configService = app.get(ConfigService<AllConfigType>);

  // Behind a load balancer the client's address comes from X-Forwarded-For; without this every
  // user would share the balancer's address (and its rate limit).
  const trustProxy = configService.getOrThrow('app.trustProxy', { infer: true });
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  app.use(helmet());
  // Request bodies: JSON and form posts up to 10 MB.
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  app.enableShutdownHooks();
  // The health checks stay outside the prefix, for the load balancer.
  app.setGlobalPrefix(configService.getOrThrow('app.apiPrefix', { infer: true }), {
    exclude: ['/', 'health', 'health/ready'],
  });
  app.enableVersioning({ type: VersioningType.URI });

  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(
    new ResolvePromisesInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
    new ResponseInterceptor(app.get(Reflector)),
  );
  app.useGlobalPipes(new TrimPipe());

  // The API docs, behind basic auth (SWAGGER_USERNAME / SWAGGER_PASSWORD).
  app.use(['/ems/docs', '/ems/docs-json', '/ems/docs-yaml'], SwaggerAuthMiddleware.use);
  const options = new DocumentBuilder()
    .setTitle('EMS API')
    .setDescription('ITPO Stall Planning Portal API docs')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('ems/docs', app, SwaggerModule.createDocument(app, options));

  await app.listen(configService.getOrThrow('app.port', { infer: true }));
}

void bootstrap();
