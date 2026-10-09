import { PlanReaderVersion1791600000000 } from './migrations/1791600000000-PlanReaderVersion';
import { CsvFloorSource1791700000000 } from './migrations/1791700000000-CsvFloorSource';
import { Rules1791800000000 } from './migrations/1791800000000-Rules';
import { Events1791900000000 } from './migrations/1791900000000-Events';
import { StallPlanning1792000000000 } from './migrations/1792000000000-StallPlanning';
import { PlanObjects1792100000000 } from './migrations/1792100000000-PlanObjects';
import { PlanPublishing1792200000000 } from './migrations/1792200000000-PlanPublishing';
import { EventHallCategoryEntity, StallCategoryEntity } from '../categories/category.entity';
import {
  PlanObjectEntity,
  PlanSeatEntity,
  PlanStallEntity,
  PlanZoneEntity,
  StallPlanEntity,
} from '../stall-plans/stall-plan.entity';
import { EventEntity, EventHallEntity } from '../events/event.entity';
import { OrganisationRulesEntity } from '../rules/rules.entity';
import { JsonFloorSource1791500000000 } from './migrations/1791500000000-JsonFloorSource';
import { FloorPlanImportEntity } from '../venues/floor-plan/plan-import.entity';
import { FloorPlanDocuments1791400000000 } from './migrations/1791400000000-FloorPlanDocuments';
import { types } from 'pg';
import type { DataSourceOptions } from 'typeorm';

import { MembershipEntity } from '../access/membership.entity';
import { AuditLogEntity } from '../audit/audit-log.entity';
import { PasswordResetTokenEntity } from '../auth/password-reset-token.entity';
import { RefreshTokenEntity } from '../auth/refresh-token.entity';
import type { DatabaseConfig } from '../config/configuration';
import { ExternalRefEntity } from '../integrations/external-ref.entity';
import { OrganisationConfigVersionEntity } from '../organisations/organisation-config-version.entity';
import { OrganisationSlugAliasEntity } from '../organisations/organisation-slug-alias.entity';
import { OrganisationEntity } from '../organisations/organisation.entity';
import { RoleEntity } from '../roles/role.entity';
import { InvitationEntity } from '../team/invitation.entity';
import { UserEntity } from '../users/user.entity';
import { HallEntity, HallFloorVersionEntity } from '../venues/hall.entity';
import { VenueEntity } from '../venues/venue.entity';
import { PlatformFoundation1791100000000 } from './migrations/1791100000000-PlatformFoundation';
import { VenuesAndHalls1791200000000 } from './migrations/1791200000000-VenuesAndHalls';
import { DrawingFloorSource1791300000000 } from './migrations/1791300000000-DrawingFloorSource';

// The pg driver returns int8 (COUNT(*)) as a string by default. Counts here are far below
// Number.MAX_SAFE_INTEGER, so parsing to a JS number is safe.
types.setTypeParser(types.builtins.INT8, (value: string) => parseInt(value, 10));
// A calendar date stays the text it is ("2026-08-10"), never a Date shifted by a time zone.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

export const ENTITIES = [
  UserEntity,
  OrganisationEntity,
  OrganisationSlugAliasEntity,
  OrganisationConfigVersionEntity,
  RoleEntity,
  MembershipEntity,
  InvitationEntity,
  RefreshTokenEntity,
  PasswordResetTokenEntity,
  AuditLogEntity,
  VenueEntity,
  HallEntity,
  HallFloorVersionEntity,
  ExternalRefEntity,
  FloorPlanImportEntity,
  OrganisationRulesEntity,
  EventEntity,
  EventHallEntity,
  StallCategoryEntity,
  EventHallCategoryEntity,
  StallPlanEntity,
  PlanZoneEntity,
  PlanStallEntity,
  PlanSeatEntity,
  PlanObjectEntity,
];

/**
 * Single source of DataSource options, shared by the Nest module and the TypeORM CLI.
 *
 * `synchronize` is always false: schema changes happen only through migrations. Entities and
 * migrations are listed explicitly rather than globbed, so the same options work from `src/`
 * (ts-node, jest) and `dist/` (production) without path tricks.
 */
export function buildDataSourceOptions(db: DatabaseConfig): DataSourceOptions {
  const base = {
    type: 'postgres' as const,
    entities: ENTITIES,
    migrations: [
      PlatformFoundation1791100000000,
      VenuesAndHalls1791200000000,
      DrawingFloorSource1791300000000,
      FloorPlanDocuments1791400000000,
      JsonFloorSource1791500000000,
      PlanReaderVersion1791600000000,
      CsvFloorSource1791700000000,
      Rules1791800000000,
      Events1791900000000,
      StallPlanning1792000000000,
      PlanObjects1792100000000,
      PlanPublishing1792200000000,
    ],
    synchronize: false,
    // A deployment owns its database, so a redeploy applies its own pending migrations.
    migrationsRun: true,
    migrationsTransactionMode: 'each' as const,
    extra: {
      max: db.poolSize,
      connectionTimeoutMillis: db.connectionTimeoutMs,
      statement_timeout: db.statementTimeoutMs,
    },
    // Managed Postgres enforces TLS; its chain is not verifiable without the CA bundle, so
    // certificate verification stays off. Credentials still travel encrypted.
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
