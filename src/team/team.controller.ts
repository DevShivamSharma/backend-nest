import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { RolesService } from '../roles/roles.service';
import type { AssignableRoleView } from '../roles/role.views';
import { ChangeRoleDto, InviteMemberDto } from './dto/team.dto';
import { InvitationsService } from './invitations.service';
import type { CreatedInvitationView, InvitationView, MemberView } from './team.views';
import { TeamService } from './team.service';

@OrgAccess('team.view')
@Controller('orgs/:slug')
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly invitations: InvitationsService,
    private readonly roles: RolesService,
  ) {}

  @Get('members')
  members(@CurrentAccess() access: OrgAccessContext): Promise<MemberView[]> {
    return this.team.list(access.organisation.id);
  }

  @RequirePermissions('team.manage')
  @Patch('members/:membershipId')
  changeRole(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<MemberView> {
    return this.team.changeRole(access, membershipId, dto.roleId, user);
  }

  @RequirePermissions('team.manage')
  @Delete('members/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<void> {
    return this.team.remove(access, membershipId, user);
  }

  /** The roles of this organisation, and which of them the current member may give. */
  @Get('roles')
  rolesList(@CurrentAccess() access: OrgAccessContext): Promise<AssignableRoleView[]> {
    return this.roles.listForOrganisation(access.organisation, access.permissions);
  }

  @Get('invitations')
  openInvitations(@CurrentAccess() access: OrgAccessContext): Promise<InvitationView[]> {
    return this.invitations.listOpen(access.organisation.id);
  }

  @RequirePermissions('team.invite')
  @Post('invitations')
  async invite(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: InviteMemberDto,
  ): Promise<CreatedInvitationView> {
    const { view } = await this.invitations.invite(access.organisation, dto, {
      actor: user,
      permissions: access.permissions,
    });
    return view;
  }

  @RequirePermissions('team.invite')
  @Post('invitations/:invitationId/resend')
  resend(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<CreatedInvitationView> {
    return this.invitations.resend(access.organisation, invitationId, {
      actor: user,
      permissions: access.permissions,
    });
  }

  @RequirePermissions('team.manage')
  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    return this.invitations.revoke(access.organisation.id, invitationId, user);
  }
}
