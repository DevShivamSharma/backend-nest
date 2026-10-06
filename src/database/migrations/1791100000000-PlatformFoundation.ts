import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The roles the platform ships with, as the Super Admin first sees them. Their permissions are
 * editable afterwards, except the locked Venue Admin, which always holds every permission.
 * A snapshot: later changes to the catalogue do not rewrite this migration.
 */
const SYSTEM_ROLES = [
  {
    key: 'venue_admin',
    name: 'Venue Admin',
    description: 'Runs the organisation: venues, events, rules, prices and its own team',
    scopeKind: 'organisation',
    permissions: [] as string[],
    locked: true,
  },
  {
    key: 'venue_architect',
    name: 'Venue Architect',
    description: 'Digitizes halls, draws internal layouts, approves external ones',
    scopeKind: 'organisation',
    permissions: [
      'org.settings.view',
      'team.view',
      'venues.view',
      'venues.manage',
      'halls.import',
      'rules.view',
      'rules.manage',
      'events.view',
      'layouts.view',
      'layouts.edit',
      'layouts.approve',
    ],
    locked: false,
  },
  {
    key: 'organiser_admin',
    name: 'Organiser Admin',
    description: 'Layout, prices and exhibitors for the halls its event booked',
    scopeKind: 'event',
    permissions: [
      'team.view',
      'team.invite',
      'venues.view',
      'rules.view',
      'events.view',
      'layouts.view',
      'layouts.edit',
      'layouts.publish',
      'pricing.view',
      'pricing.manage',
      'bookings.view',
      'bookings.manage',
      'reports.view',
    ],
    locked: false,
  },
  {
    key: 'organiser_architect',
    name: 'Organiser Architect',
    description: "Draws or uploads the stall plan for the organiser's halls",
    scopeKind: 'event',
    permissions: ['venues.view', 'rules.view', 'events.view', 'layouts.view', 'layouts.edit'],
    locked: false,
  },
  {
    key: 'exhibitor',
    name: 'Exhibitor',
    description: 'Chooses, holds and books stalls of one event',
    scopeKind: 'event',
    permissions: ['layouts.view', 'stalls.book'],
    locked: false,
  },
];

/**
 * Module A, the platform foundation: organisations (tenants) and their configuration history,
 * users, roles (dynamic RBAC), memberships, invitations, sign-in sessions, password resets and
 * the audit log.
 *
 * Every table keeps uuid keys, timestamptz times and snake_case names; every foreign key has an
 * index (or leads a unique one).
 */
export class PlatformFoundation1791100000000 implements MigrationInterface {
  name = 'PlatformFoundation1791100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(254) NOT NULL,
        name varchar(120) NOT NULL,
        password_hash text,
        is_platform_admin boolean NOT NULL DEFAULT false,
        status varchar(16) NOT NULL DEFAULT 'active',
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_key UNIQUE (email),
        CONSTRAINT users_email_lower_check CHECK (email = lower(email)),
        CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE organisations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug varchar(40) NOT NULL,
        name varchar(160) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'active',
        suspended_reason varchar(500),
        booking_mode varchar(16) NOT NULL DEFAULT 'own_portal',
        features jsonb NOT NULL,
        limits jsonb NOT NULL,
        config jsonb NOT NULL,
        config_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisations_slug_key UNIQUE (slug),
        CONSTRAINT organisations_status_check CHECK (status IN ('active', 'suspended')),
        CONSTRAINT organisations_booking_mode_check
          CHECK (booking_mode IN ('own_portal', 'embed', 'sync', 'hybrid_hold'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE organisation_slug_aliases (
        slug varchar(40) PRIMARY KEY,
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX organisation_slug_aliases_organisation_id_idx
         ON organisation_slug_aliases (organisation_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE organisation_config_versions (
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        version integer NOT NULL,
        config jsonb NOT NULL,
        changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organisation_id, version)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX organisation_config_versions_changed_by_idx
         ON organisation_config_versions (changed_by)`,
    );

    await queryRunner.query(`
      CREATE TABLE roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid REFERENCES organisations (id) ON DELETE CASCADE,
        key varchar(48) NOT NULL,
        name varchar(80) NOT NULL,
        description varchar(300),
        scope_kind varchar(16) NOT NULL,
        permissions text[] NOT NULL DEFAULT '{}'::text[],
        is_system boolean NOT NULL DEFAULT false,
        is_locked boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT roles_key_format_check CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
        CONSTRAINT roles_scope_kind_check CHECK (scope_kind IN ('organisation', 'event')),
        CONSTRAINT roles_system_is_platform_check CHECK (NOT is_system OR organisation_id IS NULL)
      )
    `);
    // A platform-wide role key is unique among platform roles; an organisation's own role key
    // is unique inside it (the service also keeps it apart from platform keys). The second
    // index serves the organisation_id foreign key too.
    await queryRunner.query(
      `CREATE UNIQUE INDEX roles_platform_key ON roles (key) WHERE organisation_id IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX roles_organisation_key ON roles (organisation_id, key)
         WHERE organisation_id IS NOT NULL`,
    );

    for (const role of SYSTEM_ROLES) {
      await queryRunner.query(
        `INSERT INTO roles (key, name, description, scope_kind, permissions, is_system, is_locked)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [role.key, role.name, role.description, role.scopeKind, role.permissions, role.locked],
      );
    }

    await queryRunner.query(`
      CREATE TABLE memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
        scope jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT memberships_user_organisation_key UNIQUE (user_id, organisation_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX memberships_organisation_id_idx ON memberships (organisation_id)`,
    );
    await queryRunner.query(`CREATE INDEX memberships_role_id_idx ON memberships (role_id)`);

    await queryRunner.query(`
      CREATE TABLE invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
        email varchar(254) NOT NULL,
        role_id uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
        scope jsonb NOT NULL DEFAULT '{}'::jsonb,
        token_hash char(64) NOT NULL,
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
        CONSTRAINT invitations_email_lower_check CHECK (email = lower(email))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX invitations_organisation_id_idx ON invitations (organisation_id)`,
    );
    await queryRunner.query(`CREATE INDEX invitations_invited_by_idx ON invitations (invited_by)`);
    await queryRunner.query(`CREATE INDEX invitations_role_id_idx ON invitations (role_id)`);
    // At most one open invitation per person and organisation; re-inviting revokes the old one.
    await queryRunner.query(
      `CREATE UNIQUE INDEX invitations_open_email_key ON invitations (organisation_id, email)
         WHERE accepted_at IS NULL AND revoked_at IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id uuid NOT NULL,
        token_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
        user_agent varchar(255),
        ip varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash)
      )
    `);
    await queryRunner.query(`CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id)`);
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_replaced_by_idx ON refresh_tokens (replaced_by)`,
    );

    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid REFERENCES organisations (id) ON DELETE SET NULL,
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_email varchar(254),
        action varchar(64) NOT NULL,
        target_type varchar(32),
        target_id varchar(64),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip varchar(64),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX audit_logs_organisation_id_created_at_idx
         ON audit_logs (organisation_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX audit_logs_actor_user_id_idx ON audit_logs (actor_user_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE audit_logs`);
    await queryRunner.query(`DROP TABLE password_reset_tokens`);
    await queryRunner.query(`DROP TABLE refresh_tokens`);
    await queryRunner.query(`DROP TABLE invitations`);
    await queryRunner.query(`DROP TABLE memberships`);
    await queryRunner.query(`DROP TABLE roles`);
    await queryRunner.query(`DROP TABLE organisation_config_versions`);
    await queryRunner.query(`DROP TABLE organisation_slug_aliases`);
    await queryRunner.query(`DROP TABLE organisations`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
