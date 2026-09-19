import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  const query = jest.fn();
  let controller: HealthController;

  beforeEach(async () => {
    query.mockReset();

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DataSource, useValue: { query } }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('liveness reports ok with an uptime and never touches the database', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(Number.isInteger(result.uptimeSeconds)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('readiness reports the database up when it answers', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);

    await expect(controller.ready()).resolves.toEqual({ status: 'ok', database: 'up' });
  });

  it('readiness is 503 when the database does not answer', async () => {
    query.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
