import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { MembershipsService } from '../../access/memberships.service';
import type { ItpoConfig } from '../../config/configuration';
import {
  BookingMode,
  defaultConfig,
  OrganisationBranding,
} from '../../organisations/organisation-config';
import type { OrganisationConfigDto } from '../../organisations/dto/organisation-config.dto';
import { OrganisationEntity } from '../../organisations/organisation.entity';
import { OrganisationsService } from '../../organisations/organisations.service';
import { RoleEntity } from '../../roles/role.entity';
import { UserEntity, UserStatus } from '../../users/user.entity';

/** The role slug ITPO gives organisers (T_CODE_MASTER). */
const ORGANISER_ROLE = 'organizer';
/** Our system roles the two kinds of ITPO user hold. */
const ADMIN_ROLE_KEY = 'venue_admin';
const ORGANISER_ROLE_KEY = 'organiser_admin';
const INVALID_CREDENTIALS = 'Email or password is incorrect.';
/** ITPO's look, as SelfCare has it: its crimson, Poppins and its logo. */
export const ITPO_BRANDING: OrganisationBranding = {
  primaryColor: '#dc344b',
  accentColor: null,
  fontFamily: 'Poppins',
  logoUrl: '/itpo-logo.svg',
  logoDarkUrl: null,
  faviconUrl: null,
};

/** One ITPO user as T_USER has it, with the role slugs of T_USERS_ROLES. */
interface ItpoUserRow {
  id: string;
  email: string;
  password: string | null;
  isActive: boolean;
  orgId: string | null;
  name: string | null;
  roles: string[];
}

export type ItpoKind = 'admin' | 'organiser';

/**
 * Sign-in with ITPO's own users, checked as ITPO's admin and organiser logins check them
 * (itpo_user AdminAuthMicroservice): a T_USER row that is not deleted, active, with a bcrypt
 * password; an organiser holds the `organizer` role and belongs to an organisation
 * (T_ORGANIZATION), an admin holds one of the configured admin roles.
 *
 * Each ITPO user is mirrored by one of our accounts (itpo_user_id) in the organisation standing
 * for ITPO, so the planner's roles and scopes apply unchanged: ITPO's admins as Venue Admin,
 * organisers as Organiser Admin. Nothing in ITPO's tables is written but the last sign-in.
 */
@Injectable()
export class ItpoIdentityService {
  private readonly logger = new Logger(ItpoIdentityService.name);
  private readonly itpo: ItpoConfig;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly organisations: OrganisationsService,
    private readonly memberships: MembershipsService,
    config: ConfigService,
  ) {
    this.itpo = config.getOrThrow<ItpoConfig>('itpo');
  }

  get enabled(): boolean {
    return this.itpo.authSource === 'itpo';
  }

  /** The ITPO user these credentials sign in, as our account; refused with one message. */
  async signIn(email: string, password: string, ip: string | null): Promise<UserEntity> {
    const row = await this.findItpoUser(email);
    const kind = row ? this.kindOf(row) : null;
    const valid =
      !!row?.password && (await bcrypt.compare(password, row.password).catch(() => false));
    if (!row || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (!row.isActive) {
      throw new UnauthorizedException('This account is blocked. Contact ITPO.');
    }
    if (!kind) {
      throw new UnauthorizedException('This ITPO account has no access to stall planning.');
    }
    if (kind === 'organiser' && !row.orgId) {
      throw new UnauthorizedException('This organiser account is not linked to an organisation.');
    }

    const user = await this.dataSource.transaction((em) => this.mirror(em, row, kind));
    await this.brandOnce(user);
    // As ITPO's own logins do; the only write to ITPO's tables.
    await this.dataSource.query(
      `UPDATE idp."T_USER" SET "last_login_date" = NOW(), "last_login_ip" = $1 WHERE id = $2`,
      [ip, row.id],
    );
    if (kind === 'organiser' && row.orgId) {
      await this.dataSource.query(
        `UPDATE idp."T_ORGANIZATION" SET "last_login_date" = NOW() WHERE id = $1`,
        [row.orgId],
      );
    }
    return user;
  }

  /** Admin, organiser, or neither, by the ITPO user's roles. */
  kindOf(row: Pick<ItpoUserRow, 'roles'>): ItpoKind | null {
    if (row.roles.includes(ORGANISER_ROLE)) return 'organiser';
    if (row.roles.some((r) => this.itpo.adminRoles.includes(r))) return 'admin';
    return null;
  }

  private async findItpoUser(email: string): Promise<ItpoUserRow | null> {
    const rows: ItpoUserRow[] = await this.dataSource.query(
      `SELECT u.id,
              u.email,
              u.password,
              u."isActive" AS "isActive",
              u.org_id AS "orgId",
              p.name,
              COALESCE(
                array_agg(DISTINCT c.slug) FILTER (WHERE c.slug IS NOT NULL),
                '{}'
              ) AS roles
         FROM idp."T_USER" u
         LEFT JOIN idp."T_USER_PROFILE" p ON p.user_id = u.id
         LEFT JOIN idp."T_USERS_ROLES" ur ON ur.user_id = u.id
         LEFT JOIN idp."T_CODE_MASTER" c ON c.id = ur.role_id
        WHERE lower(u.email) = lower($1)
          AND u."deletedAt" IS NULL
        GROUP BY u.id, p.name
        ORDER BY u."updatedAt" DESC NULLS LAST
        LIMIT 1`,
      [email.trim()],
    );
    return rows[0] ?? null;
  }

  /** Our account for the ITPO user, in the ITPO organisation, with the role of its kind. */
  private async mirror(em: EntityManager, row: ItpoUserRow, kind: ItpoKind): Promise<UserEntity> {
    const users = em.getRepository(UserEntity);
    const email = row.email.trim().toLowerCase();
    const name = (row.name?.trim() || email.split('@')[0]).slice(0, 120);
    let user =
      (await users.findOneBy({ itpoUserId: row.id })) ?? (await users.findOneBy({ email }));
    if (user) {
      Object.assign(user, { email, name, itpoUserId: row.id, itpoOrgId: row.orgId });
      if (user.status !== UserStatus.Active) user.status = UserStatus.Active;
    } else {
      user = users.create({
        email,
        name,
        passwordHash: null,
        status: UserStatus.Active,
        itpoUserId: row.id,
        itpoOrgId: row.orgId,
      });
    }
    user = await users.save(user);
    user.lastLoginAt = new Date();
    await users.update({ id: user.id }, { lastLoginAt: user.lastLoginAt });

    const organisation = await this.itpoOrganisation(em, user);
    const role = await em.getRepository(RoleEntity).findOneByOrFail({
      key: kind === 'admin' ? ADMIN_ROLE_KEY : ORGANISER_ROLE_KEY,
      organisationId: IsNull(),
    });
    const existing = await this.memberships.findWithRole(user.id, organisation.id);
    await this.memberships.upsert(em, {
      userId: user.id,
      organisationId: organisation.id,
      roleId: role.id,
      // An organiser keeps the events they were given; an admin sees the whole organisation.
      scope: kind === 'admin' ? {} : (existing?.scope ?? { eventIds: [] }),
    });
    return user;
  }

  /**
   * Gives the ITPO organisation ITPO's look while it still has the platform's default one;
   * a look chosen since is left alone.
   */
  private async brandOnce(actor: UserEntity): Promise<void> {
    const organisation = await this.dataSource
      .getRepository(OrganisationEntity)
      .findOneBy({ slug: this.itpo.orgSlug });
    if (!organisation) return;
    const now = organisation.config.branding;
    const platform = defaultConfig(organisation.name).branding;
    if (now.primaryColor !== platform.primaryColor || now.fontFamily !== platform.fontFamily) {
      return;
    }
    await this.organisations.updateConfig(
      organisation.id,
      { ...organisation.config, branding: ITPO_BRANDING } as OrganisationConfigDto,
      { id: actor.id, email: actor.email },
    );
  }

  /** The organisation standing for ITPO, made on the first ITPO sign-in. */
  private async itpoOrganisation(
    em: EntityManager,
    actor: UserEntity,
  ): Promise<OrganisationEntity> {
    const found = await em.getRepository(OrganisationEntity).findOneBy({ slug: this.itpo.orgSlug });
    if (found) return found;
    this.logger.log(`Creating the organisation "${this.itpo.orgSlug}" for ITPO's users.`);
    return this.organisations.create(
      { name: this.itpo.orgName, slug: this.itpo.orgSlug, bookingMode: BookingMode.Sync },
      { id: actor.id, email: actor.email },
      em,
    );
  }
}
