import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { AuditService, AuditLogView } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { Page, PageQueryDto } from '../common/pagination';
import { OrganisationConfigDto } from '../organisations/dto/organisation-config.dto';
import type { OrganisationConfig } from '../organisations/organisation-config';
import type { ConfigVersionView } from '../organisations/organisation.views';
import { OrganisationsService } from '../organisations/organisations.service';

export interface OrgSettingsView {
  config: OrganisationConfig;
  configVersion: number;
}

/** The organisation's own look and paperwork, edited by its members with the permission. */
@OrgAccess('org.settings.view')
@Controller('orgs/:slug')
export class OrgSettingsController {
  constructor(
    private readonly organisations: OrganisationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  get(@CurrentAccess() access: OrgAccessContext): OrgSettingsView {
    return {
      config: access.organisation.config,
      configVersion: access.organisation.configVersion,
    };
  }

  @RequirePermissions('org.settings.manage')
  @Put('settings/config')
  async update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: OrganisationConfigDto,
  ): Promise<OrgSettingsView> {
    const saved = await this.organisations.updateConfig(access.organisation.id, dto, user);
    return { config: saved.config, configVersion: saved.configVersion };
  }

  @Get('settings/config/versions')
  versions(@CurrentAccess() access: OrgAccessContext): Promise<ConfigVersionView[]> {
    return this.organisations.listConfigVersions(access.organisation.id);
  }

  @RequirePermissions('org.settings.manage')
  @Post('settings/config/versions/:version/restore')
  async restore(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<OrgSettingsView> {
    const saved = await this.organisations.restoreConfigVersion(
      access.organisation.id,
      version,
      user,
    );
    return { config: saved.config, configVersion: saved.configVersion };
  }

  @RequirePermissions('audit.view')
  @Get('audit')
  auditLog(
    @CurrentAccess() access: OrgAccessContext,
    @Query() query: PageQueryDto,
  ): Promise<Page<AuditLogView>> {
    return this.audit.list({
      organisationId: access.organisation.id,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
