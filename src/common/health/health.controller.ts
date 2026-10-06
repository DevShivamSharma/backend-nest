import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Public } from '../decorators/public.decorator';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: 'ok';
  database: 'up';
}

/**
 *  GET /health        liveness  — the process is up. Never touches the database.
 *  GET /health/ready  readiness — the database answers. 503 when it does not.
 *
 * Both sit outside the `/api` prefix and need no sign-in.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  check(): HealthResponse {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database is not reachable.');
    }

    return { status: 'ok', database: 'up' };
  }
}
