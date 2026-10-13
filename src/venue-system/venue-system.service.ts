import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { sealSecret } from '../common/sealed-secret';
import type { Actor } from '../common/http/authenticated-request';
import type { AppConfig, VenueSystemConfig } from '../config/configuration';
import { Environment } from '../config/env.validation';
import { OrganisationEntity } from '../organisations/organisation.entity';
import { VenueIntegrationDto } from './dto/venue-system.dto';
import { VenueSystemIntegrationEntity } from './venue-system-integration.entity';
import type { VenueIntegrationView } from './venue-system.views';

/**
 * An organisation's link to its venue system (docs/15 §3.1): where a published plan is pushed
 * and the sealed secret it is signed with. The secret is write-only: it goes in sealed and only
 * its last four characters ever come back out.
 */
@Injectable()
export class VenueSystemService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async view(organisationId: string): Promise<VenueIntegrationView> {
    const em = this.dataSource.manager;
    if (!(await em.getRepository(OrganisationEntity).existsBy({ id: organisationId }))) {
      throw new NotFoundException('No such organisation.');
    }
    const row = await em
      .getRepository(VenueSystemIntegrationEntity)
      .findOneBy({ organisationId });
    return {
      configured: !!row,
      callbackUrl: row?.callbackUrl ?? null,
      secretHint: row?.secretHint ?? null,
      enabled: row?.enabled ?? false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      // The newest push joins plan_deliveries, which arrives with the delivery work.
      lastDelivery: null,
    };
  }

  async save(
    organisationId: string,
    dto: VenueIntegrationDto,
    actor: Actor,
  ): Promise<VenueIntegrationView> {
    const production = this.config.getOrThrow<AppConfig>('app').env === Environment.Production;
    const key = this.config.getOrThrow<VenueSystemConfig>('venueSystem').secretKey;
    await this.dataSource.transaction(async (em) => {
      if (!(await em.getRepository(OrganisationEntity).existsBy({ id: organisationId }))) {
        throw new NotFoundException('No such organisation.');
      }
      if (production && dto.callbackUrl.toLowerCase().startsWith('http://')) {
        throw new BadRequestException(
          'Use an https:// address: the plan and its signature must not travel in clear text.',
        );
      }
      const repo = em.getRepository(VenueSystemIntegrationEntity);
      const existing = await repo.findOneBy({ organisationId });
      if (!existing && !dto.secret) {
        throw new BadRequestException('Set the shared secret ITPO gave you.');
      }
      if (dto.secret && !key) {
        throw new BadRequestException(
          'The server has no INTEGRATION_SECRET_KEY, so it cannot keep a secret. Set it and restart.',
        );
      }
      const row =
        existing ?? repo.create({ organisationId, createdById: actor.id, secretSealed: '' });
      row.callbackUrl = dto.callbackUrl;
      row.enabled = dto.enabled;
      row.updatedById = actor.id;
      if (dto.secret && key) {
        row.secretSealed = sealSecret(dto.secret, key, organisationId);
        row.secretHint = dto.secret.slice(-4);
      }
      await repo.save(row);
      await this.audit.record(
        {
          action: 'integration.updated',
          actor,
          organisationId,
          targetType: 'organisation',
          targetId: organisationId,
          metadata: {
            host: new URL(dto.callbackUrl).host,
            enabled: dto.enabled,
            secretChanged: !!dto.secret,
          },
        },
        em,
      );
    });
    return this.view(organisationId);
  }
}
