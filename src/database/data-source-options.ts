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
