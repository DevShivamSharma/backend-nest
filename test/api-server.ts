import './setup-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

async function start() {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 18081), '127.0.0.1');
}
void start();
