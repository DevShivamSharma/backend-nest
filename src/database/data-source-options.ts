import { types } from 'pg';
import type { DataSourceOptions } from 'typeorm';

import type { DatabaseConfig } from '../config/configuration';
import { HallEntity } from '../layouts/entities/hall.entity';
import { LayoutEntity } from '../layouts/entities/layout.entity';
import { StallEntity } from '../layouts/entities/stall.entity';
import { Baseline1758240000000 } from './migrations/1758240000000-Baseline';

// The pg driver returns int8 (bigint ids, COUNT(*)) as strings by default. The API contract
// sends ids as JSON numbers, exactly as Jackson serialised Java `Long`. Ids here are far below
// Number.MAX_SAFE_INTEGER, so parsing to a JS number is safe.
types.setTypeParser(types.builtins.INT8, (value: string) => parseInt(value, 10));

/**
 * Single source of DataSource options, shared by the Nest module and the TypeORM CLI.
 *
 * `synchronize` is false unconditionally (ADR-006): schema changes happen only via migrations.
 * Entities and migrations are listed explicitly rather than globbed, so the same options work
 * from `src/` (ts-node, jest) and `dist/` (production) without path tricks.
 */
export function buildDataSourceOptions(db: DatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    database: db.name,
    username: db.user,
    password: db.password,
    entities: [HallEntity, LayoutEntity, StallEntity],
    migrations: [Baseline1758240000000],
    synchronize: false,
    migrationsRun: false,
    extra: {
      max: db.poolSize,
      connectionTimeoutMillis: db.connectionTimeoutMs,
      statement_timeout: db.statementTimeoutMs,
    },
  };
}
