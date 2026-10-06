import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuthUser } from '../common/http/authenticated-request';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Page } from '../common/pagination';
import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';
import { OrganisationConfigDto } from '../organisations/dto/organisation-config.dto';
import { OrganisationStatus } from '../organisations/organisation.entity';
import {
  ConfigVersionView,
  OrganisationView,
  toOrganisationView,
} from '../organisations/organisation.views';
import {
  OrganisationsService,
  OrganisationSummary,
  SlugCheck,
} from '../organisations/organisations.service';
import { ALL_PERMISSIONS } from '../roles/permissions';
import { RolesService } from '../roles/roles.service';
import { InvitationsService } from '../team/invitations.service';
import type { CreatedInvitationView, InvitationView, MemberView } from '../team/team.views';
import { TeamService } from '../team/team.service';
import {
  AdminInviteDto,
  ChangeSlugDto,
  CreateOrganisationDto,
  OrganisationListQueryDto,
  SlugCheckQueryDto,
  SuspendDto,
  UpdateOrganisationDto,
} from './dto/admin-organisation.dto';

export interface OrganisationDetailView extends OrganisationView {
  aliases: string[];
  members: MemberView[];
  invitations: InvitationView[];
}

export interface CreatedOrganisationView {
  organisation: OrganisationView;
  invitation: CreatedInvitationView;
}

/**
 * The Super Admin's console for organisations. It manages the tenant itself (link, plan,
 * features, branding, status, admins) but never its business data.
 */
@PlatformAdminOnly()
@Controller('admin/organisations')
export class AdminOrganisationsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly organisations: OrganisationsService,
    private readonly roles: RolesService,
    private readonly invitations: InvitationsService,
    private readonly team: TeamService,
  ) {}

  @Get()
  list(@Query() query: OrganisationListQueryDto): Promise<Page<OrganisationSummary>> {
    return this.organisations.list(query);
  }

  @Get('slug-check')
  slugCheck(@Query() query: SlugCheckQueryDto): Promise<SlugCheck> {
    return this.organisations.checkSlug(query.slug, query.organisationId);
  }

  /** Creates the organisation and invites its first Venue Admin, all or nothing. */
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrganisationDto,
  ): Promise<CreatedOrganisationView> {
    const { organisation, invitation, send } = await this.dataSource.transaction(async (em) => {
      const created = await this.organisations.create(dto, user, em);
      const owner = await this.roles.getOwnerRole(em);
      const invited = await this.invitations.invite(
        created,
        { email: dto.firstAdmin.email, roleId: owner.id },
        { actor: user, permissions: ALL_PERMISSIONS },
        em,
      );
      return { organisation: created, invitation: invited.view, send: invited.send };
    });
    await send();
    return { organisation: toOrganisationView(organisation), invitation };
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<OrganisationDetailView> {
    const organisation = await this.organisations.getById(id);
    const [aliases, members, invitations] = await Promise.all([
      this.organisations.aliasesOf(id),
      this.team.list(id),
      this.invitations.listOpen(id),
    ]);
    return { ...toOrganisationView(organisation), aliases, members, invitations };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganisationDto,
  ): Promise<OrganisationView> {
    return toOrganisationView(await this.organisations.updatePlatformSettings(id, dto, user));
  }

  @Put(':id/slug')
  async changeSlug(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeSlugDto,
  ): Promise<OrganisationView> {
    return toOrganisationView(await this.organisations.changeSlug(id, dto.slug, user));
  }

  @Post(':id/suspend')
  async suspend(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendDto,
  ): Promise<OrganisationView> {
    return toOrganisationView(
      await this.organisations.setStatus(id, OrganisationStatus.Suspended, dto.reason, user),
    );
  }

  @Post(':id/activate')
  async activate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrganisationView> {
    return toOrganisationView(
      await this.organisations.setStatus(id, OrganisationStatus.Active, null, user),
    );
  }

  /** Branding is checked by the platform before an organisation goes live, so it can edit it too. */
  @Put(':id/config')
  async updateConfig(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrganisationConfigDto,
  ): Promise<OrganisationView> {
    return toOrganisationView(await this.organisations.updateConfig(id, dto, user));
  }

  @Get(':id/config/versions')
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<ConfigVersionView[]> {
    return this.organisations.listConfigVersions(id);
  }

  /** Invites another admin, for example when the first one left before accepting. */
  @Post(':id/invitations')
  async invite(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminInviteDto,
  ): Promise<CreatedInvitationView> {
    const organisation = await this.organisations.getById(id);
    const roleId = dto.roleId ?? (await this.roles.getOwnerRole()).id;
    const { view } = await this.invitations.invite(
      organisation,
      { email: dto.email, roleId },
      { actor: user, permissions: ALL_PERMISSIONS },
    );
    return view;
  }
}
