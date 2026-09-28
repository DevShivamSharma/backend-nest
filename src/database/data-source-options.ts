import { AddPlacementAndSplits1758240600000 } from './migrations/1758240600000-AddPlacementAndSplits';
import { AddStallFootprint1758240700000 } from './migrations/1758240700000-AddStallFootprint';
import { types } from 'pg';
import type { DataSourceOptions } from 'typeorm';

import type { DatabaseConfig } from '../config/configuration';
import { HallEntity } from '../layouts/entities/hall.entity';
import { LayoutEntity } from '../layouts/entities/layout.entity';
import { StallEntity } from '../layouts/entities/stall.entity';
import { Baseline1758240000000 } from './migrations/1758240000000-Baseline';
import { AddBlockedAreas1758240100000 } from './migrations/1758240100000-AddBlockedAreas';
import { AddStallOpenSides1758240200000 } from './migrations/1758240200000-AddStallOpenSides';
import { AddLayoutRulesAndStallIdentity1758240300000 } from './migrations/1758240300000-AddLayoutRulesAndStallIdentity';
import { AddHallAmenities1758240400000 } from './migrations/1758240400000-AddHallAmenities';
import { AddHallCompassAndLegends1758240500000 } from './migrations/1758240500000-AddHallCompassAndLegends';

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
  const base = {
    type: 'postgres' as const,
    entities: [HallEntity, LayoutEntity, StallEntity],
    migrations: [
      Baseline1758240000000,
      AddBlockedAreas1758240100000,
      AddStallOpenSides1758240200000,
      AddLayoutRulesAndStallIdentity1758240300000,
      AddHallAmenities1758240400000,
      AddHallCompassAndLegends1758240500000,
      AddPlacementAndSplits1758240600000,
      AddStallFootprint1758240700000,
    ],
    synchronize: false,
    // Run pending migrations at startup: the published deployment owns its database, so a
    // redeploy self-applies new columns. All migrations are idempotent (IF NOT EXISTS), and
    // databases with a recorded history simply skip them.
    migrationsRun: true,
    extra: {
      max: db.poolSize,
      connectionTimeoutMillis: db.connectionTimeoutMs,
      statement_timeout: db.statementTimeoutMs,
    },
    // Managed Postgres (Supabase) enforces TLS; its chain is not verifiable without the CA
    // bundle, so certificate verification stays off. Credentials still travel encrypted.
    ...(db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  };

  return db.url
    ? { ...base, url: db.url }
    : {
        ...base,
        host: db.host,
        port: db.port,
        database: db.name,
        username: db.user,
        password: db.password,
      };
}
