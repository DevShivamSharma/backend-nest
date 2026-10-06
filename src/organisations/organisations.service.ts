import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import type { Page } from '../common/pagination';
import { OrganisationConfigDto } from './dto/organisation-config.dto';
import { FeaturesDto, LimitsDto } from './dto/platform-settings.dto';
import {
  BookingMode,
  DEFAULT_FEATURES,
  DEFAULT_LIMITS,
  defaultConfig,
  OrganisationConfig,
  RESERVED_SLUGS,
  SLUG_PATTERN,
} from './organisation-config';
import { OrganisationConfigVersionEntity } from './organisation-config-version.entity';
import { OrganisationSlugAliasEntity } from './organisation-slug-alias.entity';
import { OrganisationEntity, OrganisationStatus } from './organisation.entity';
import type { ConfigVersionView } from './organisation.views';

export interface NewOrganisation {
  name: string;
  slug: string;
  bookingMode?: BookingMode;
  features?: FeaturesDto;
  limits?: LimitsDto;
  primaryColor?: string;
}

export interface PlatformSettingsChange {
  name?: string;
  bookingMode?: BookingMode;
  features?: FeaturesDto;
  limits?: LimitsDto;
}

export interface SlugCheck {
  slug: string;
  available: boolean;
  reason: string | null;
}

export interface OrganisationSummary {
  id: string;
  slug: string;
  name: string;
  status: OrganisationStatus;
  bookingMode: BookingMode;
  primaryColor: string;
  logoUrl: string | null;
  memberCount: number;
  openInvitationCount: number;
  createdAt: string;
}

export interface OrganisationListQuery {
  q?: string;
  status?: OrganisationStatus;
  page: number;
  pageSize: number;
}

@Injectable()
export class OrganisationsService {
  constructor(
    @InjectRepository(OrganisationEntity)
    private readonly organisations: Repository<OrganisationEntity>,
    @InjectRepository(OrganisationSlugAliasEntity)
    private readonly aliases: Repository<OrganisationSlugAliasEntity>,
    @InjectRepository(OrganisationConfigVersionEntity)
    private readonly versions: Repository<OrganisationConfigVersionEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether a slug can be given to an organisation. Taken means used by another organisation
   * now or before (an alias); an organisation may take back one of its own old slugs.
   */
  async checkSlug(
    slug: string,
    organisationId?: string,
    manager?: EntityManager,
  ): Promise<SlugCheck> {
    const normalised = slug.trim().toLowerCase();
    const fail = (reason: string): SlugCheck => ({ slug: normalised, available: false, reason });

    if (!SLUG_PATTERN.test(normalised)) {
      return fail(
        'Use 3–40 lower-case letters, digits and single hyphens, starting with a letter.',
      );
    }
    if (RESERVED_SLUGS.has(normalised)) {
      return fail('This word is used by the app itself.');
    }

    const em = manager ?? this.dataSource.manager;
    const current = await em.getRepository(OrganisationEntity).findOneBy({ slug: normalised });
    if (current && current.id !== organisationId) {
      return fail('Another organisation uses this link.');
    }
    const alias = await em
      .getRepository(OrganisationSlugAliasEntity)
      .findOneBy({ slug: normalised });
    if (alias && alias.organisationId !== organisationId) {
      return fail('Another organisation used this link before; old links still lead there.');
    }
    return { slug: normalised, available: true, reason: null };
  }

  /** Creates the organisation and its first configuration version, inside the caller's transaction. */
  async create(
    input: NewOrganisation,
    actor: Actor,
    manager: EntityManager,
  ): Promise<OrganisationEntity> {
    const check = await this.checkSlug(input.slug, undefined, manager);
    if (!check.available) {
      throw new ConflictException(check.reason);
    }

    const config = defaultConfig(input.name);
    if (input.primaryColor) {
      config.branding.primaryColor = input.primaryColor.toLowerCase();
    }

    const repo = manager.getRepository(OrganisationEntity);
    const organisation = await repo.save(
      repo.create({
        slug: check.slug,
        name: input.name,
        status: OrganisationStatus.Active,
        bookingMode: input.bookingMode ?? BookingMode.OwnPortal,
        features: { ...DEFAULT_FEATURES, ...input.features },
        limits: { ...DEFAULT_LIMITS, ...input.limits },
        config,
        configVersion: 1,
      }),
    );

    await manager.getRepository(OrganisationConfigVersionEntity).insert({
      organisationId: organisation.id,
      version: 1,
      config,
      changedById: actor.id,
    });

    await this.audit.record(
      {
        action: 'organisation.created',
        actor,
        organisationId: organisation.id,
        targetType: 'organisation',
        targetId: organisation.id,
        metadata: { slug: organisation.slug, name: organisation.name },
      },
      manager,
    );

    return organisation;
  }

  findActiveBySlug(slug: string): Promise<OrganisationEntity | null> {
    return this.organisations.findOneBy({ slug, status: OrganisationStatus.Active });
  }

  /**
   * The organisation a public link names: by its slug, or by an old slug it used before. A
   * suspended organisation is treated as unknown.
   */
  async resolvePublic(slug: string): Promise<OrganisationEntity | null> {
    const normalised = slug.trim().toLowerCase();
    const direct = await this.organisations.findOneBy({ slug: normalised });
    const organisation =
      direct ??
      (await this.aliases
        .findOne({ where: { slug: normalised }, relations: { organisation: true } })
        .then((alias) => alias?.organisation ?? null));

    return organisation?.status === OrganisationStatus.Active ? organisation : null;
  }

  async getById(id: string, manager?: EntityManager): Promise<OrganisationEntity> {
    const organisation = await (manager ?? this.dataSource.manager)
      .getRepository(OrganisationEntity)
      .findOneBy({ id });
    if (!organisation) {
      throw new NotFoundException('Organisation not found.');
    }
    return organisation;
  }

  async aliasesOf(organisationId: string): Promise<string[]> {
    const rows = await this.aliases.find({
      where: { organisationId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => row.slug);
  }

  async list(query: OrganisationListQuery): Promise<Page<OrganisationSummary>> {
    const qb = this.organisations
      .createQueryBuilder('org')
      .select('org')
      .addSelect(
        (sub) =>
          sub.select('count(*)').from('memberships', 'm').where('m.organisation_id = org.id'),
        'member_count',
      )
      .addSelect(
        (sub) =>
          sub
            .select('count(*)')
            .from('invitations', 'i')
            .where('i.organisation_id = org.id')
            .andWhere('i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()'),
        'open_invitation_count',
      )
      .orderBy('org.name', 'ASC');

    if (query.q) {
      qb.andWhere('(org.name ILIKE :q OR org.slug ILIKE :q)', { q: `%${escapeLike(query.q)}%` });
    }
    if (query.status) {
      qb.andWhere('org.status = :status', { status: query.status });
    }

    const total = await qb.getCount();
    const { entities, raw } = await qb
      .offset((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .getRawAndEntities<{ member_count: number; open_invitation_count: number }>();

    return {
      items: entities.map((org, index) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        status: org.status,
        bookingMode: org.bookingMode,
        primaryColor: org.config.branding.primaryColor,
        logoUrl: org.config.branding.logoUrl,
        memberCount: Number(raw[index]?.member_count ?? 0),
        openInvitationCount: Number(raw[index]?.open_invitation_count ?? 0),
        createdAt: org.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async updatePlatformSettings(
    id: string,
    change: PlatformSettingsChange,
    actor: Actor,
  ): Promise<OrganisationEntity> {
    return this.dataSource.transaction(async (manager) => {
      const organisation = await this.lock(manager, id);
      const before = {
        name: organisation.name,
        bookingMode: organisation.bookingMode,
        features: organisation.features,
        limits: organisation.limits,
      };

      if (change.name !== undefined) organisation.name = change.name;
      if (change.bookingMode !== undefined) organisation.bookingMode = change.bookingMode;
      if (change.features !== undefined) organisation.features = { ...change.features };
      if (change.limits !== undefined) organisation.limits = { ...change.limits };

      const saved = await manager.getRepository(OrganisationEntity).save(organisation);
      await this.audit.record(
        {
          action: 'organisation.updated',
          actor,
          organisationId: id,
          targetType: 'organisation',
          targetId: id,
          metadata: {
            before,
            after: {
              name: saved.name,
              bookingMode: saved.bookingMode,
              features: saved.features,
              limits: saved.limits,
            },
          },
        },
        manager,
      );
      return saved;
    });
  }

  /** The old slug becomes an alias, so links already shared keep working. */
  async changeSlug(id: string, slug: string, actor: Actor): Promise<OrganisationEntity> {
    return this.dataSource.transaction(async (manager) => {
      const organisation = await this.lock(manager, id);
      const check = await this.checkSlug(slug, id, manager);
      if (!check.available) {
        throw new ConflictException(check.reason);
      }
      if (check.slug === organisation.slug) {
        return organisation;
      }

      const previous = organisation.slug;
      const aliases = manager.getRepository(OrganisationSlugAliasEntity);
      await aliases.delete({ slug: check.slug, organisationId: id });
      await aliases.insert({ slug: previous, organisationId: id });

      organisation.slug = check.slug;
      const saved = await manager.getRepository(OrganisationEntity).save(organisation);

      await this.audit.record(
        {
          action: 'organisation.slug_changed',
          actor,
          organisationId: id,
          targetType: 'organisation',
          targetId: id,
          metadata: { from: previous, to: saved.slug },
        },
        manager,
      );
      return saved;
    });
  }

  /** A suspended organisation's links show the invalid-link page and its APIs answer 404. */
  async setStatus(
    id: string,
    status: OrganisationStatus,
    reason: string | null,
    actor: Actor,
  ): Promise<OrganisationEntity> {
    return this.dataSource.transaction(async (manager) => {
      const organisation = await this.lock(manager, id);
      if (organisation.status === status) {
        return organisation;
      }
      organisation.status = status;
      organisation.suspendedReason = status === OrganisationStatus.Suspended ? reason : null;
      const saved = await manager.getRepository(OrganisationEntity).save(organisation);

      await this.audit.record(
        {
          action:
            status === OrganisationStatus.Suspended
              ? 'organisation.suspended'
              : 'organisation.activated',
          actor,
          organisationId: id,
          targetType: 'organisation',
          targetId: id,
          metadata: reason ? { reason } : {},
        },
        manager,
      );
      return saved;
    });
  }

  /** Saves the configuration as the next version; earlier versions stay restorable. */
  async updateConfig(
    id: string,
    dto: OrganisationConfigDto,
    actor: Actor,
    action = 'organisation.config_updated',
    metadata: Record<string, unknown> = {},
  ): Promise<OrganisationEntity> {
    const config = OrganisationsService.toConfig(dto);
    if (!config.locale.languages.includes(config.locale.defaultLanguage)) {
      throw new BadRequestException('The default language must be one of the languages offered.');
    }

    return this.dataSource.transaction(async (manager) => {
      const organisation = await this.lock(manager, id);
      const version = organisation.configVersion + 1;

      await manager.getRepository(OrganisationConfigVersionEntity).insert({
        organisationId: id,
        version,
        config,
        changedById: actor.id,
      });

      organisation.config = config;
      organisation.configVersion = version;
      const saved = await manager.getRepository(OrganisationEntity).save(organisation);

      await this.audit.record(
        {
          action,
          actor,
          organisationId: id,
          targetType: 'organisation',
          targetId: id,
          metadata: { version, ...metadata },
        },
        manager,
      );
      return saved;
    });
  }

  async listConfigVersions(id: string): Promise<ConfigVersionView[]> {
    const organisation = await this.getById(id);
    const rows = await this.versions.find({
      where: { organisationId: id },
      relations: { changedBy: true },
      order: { version: 'DESC' },
      take: 50,
    });
    return rows.map((row) => ({
      version: row.version,
      config: row.config,
      changedBy: row.changedBy
        ? { id: row.changedBy.id, name: row.changedBy.name, email: row.changedBy.email }
        : null,
      createdAt: row.createdAt.toISOString(),
      current: row.version === organisation.configVersion,
    }));
  }

  /** Restoring copies an old version forward as the newest one; history is never rewritten. */
  async restoreConfigVersion(
    id: string,
    version: number,
    actor: Actor,
  ): Promise<OrganisationEntity> {
    const row = await this.versions.findOneBy({ organisationId: id, version });
    if (!row) {
      throw new NotFoundException('That version does not exist.');
    }
    return this.updateConfig(
      id,
      row.config as OrganisationConfigDto,
      actor,
      'organisation.config_restored',
      {
        restoredFrom: version,
      },
    );
  }

  private async lock(manager: EntityManager, id: string): Promise<OrganisationEntity> {
    const organisation = await manager
      .getRepository(OrganisationEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!organisation) {
      throw new NotFoundException('Organisation not found.');
    }
    return organisation;
  }

  /** Fills every optional field, so a stored configuration always has the full shape. */
  static toConfig(dto: OrganisationConfigDto): OrganisationConfig {
    return {
      branding: {
        primaryColor: dto.branding.primaryColor.toLowerCase(),
        accentColor: dto.branding.accentColor?.toLowerCase() ?? null,
        fontFamily: dto.branding.fontFamily,
        logoUrl: dto.branding.logoUrl ?? null,
        logoDarkUrl: dto.branding.logoDarkUrl ?? null,
        faviconUrl: dto.branding.faviconUrl ?? null,
      },
      locale: {
        defaultLanguage: dto.locale.defaultLanguage,
        languages: [...dto.locale.languages],
        currency: dto.locale.currency.toUpperCase(),
        timezone: dto.locale.timezone,
      },
      legal: {
        legalName: dto.legal.legalName ?? null,
        gstin: dto.legal.gstin ?? null,
        address: dto.legal.address ?? null,
        invoicePrefix: dto.legal.invoicePrefix ?? null,
        supportEmail: dto.legal.supportEmail?.toLowerCase() ?? null,
      },
      email: {
        senderName: dto.email.senderName ?? null,
        replyTo: dto.email.replyTo?.toLowerCase() ?? null,
        footer: dto.email.footer ?? null,
      },
    };
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
