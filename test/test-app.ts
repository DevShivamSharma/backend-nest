import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { buildDataSourceOptions } from '../src/database/data-source-options';
import { configuration } from '../src/config/configuration';
import { UserEntity } from '../src/users/user.entity';

export const SUPER_ADMIN = { email: 'root@platform.test', password: 'root-password-123' };

/** Empties the test database, so the app's startup migrations build a fresh schema. */
async function resetDatabase(): Promise<void> {
  const ds = new DataSource({
    ...buildDataSourceOptions(configuration().database),
    migrationsRun: false,
  });
  await ds.initialize();
  try {
    await ds.query('DROP SCHEMA public CASCADE');
    await ds.query('CREATE SCHEMA public');
  } finally {
    await ds.destroy();
  }
}

export async function createTestApp(): Promise<INestApplication> {
  await resetDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'], rawBody: true });
  configureApp(app);
  await app.init();

  await app
    .get(DataSource)
    .getRepository(UserEntity)
    .insert({
      email: SUPER_ADMIN.email,
      name: 'Root',
      isPlatformAdmin: true,
      passwordHash: await argon2.hash(SUPER_ADMIN.password),
    });
  return app;
}

export async function login(
  app: INestApplication,
  email: string,
  password: string,
): Promise<{ token: string; cookie: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  return { token: res.body.accessToken as string, cookie: refreshCookie(res) };
}

export function refreshCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('rt='));
  if (!cookie) {
    throw new Error('No refresh cookie was set.');
  }
  return cookie.split(';')[0];
}

export function tokenFrom(inviteUrl: string): string {
  const token = new URL(inviteUrl).searchParams.get('token');
  if (!token) {
    throw new Error(`No token in ${inviteUrl}`);
  }
  return token;
}
