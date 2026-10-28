import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';

/**
 * Boots the whole app against the database and Redis in the environment (see env-example-relational
 * and docker-compose.relational.ci.yaml); run with `npm run test:e2e`.
 */
describe('App (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should answer the liveness check', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
  });
});
