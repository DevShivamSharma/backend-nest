import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../common/http/authenticated-request';
import { OrganisationsService } from '../organisations/organisations.service';
import { holdsAll, Permission } from '../roles/permissions';
import { RoleScopeKind } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import { MembershipsService } from './memberships.service';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const EVENT_ROLES_KEY = 'allowEventRoles';

/**
 * Guards every `/orgs/:slug/...` data route, in this order:
 *  1. the slug names an active organisation, else 404 (suspended looks the same as unknown);
 *  2. the signed-in user is a member, else 403 — the Super Admin is not a member by default;
 *  3. a member with an event role (an organiser) uses only routes made for them, else 403;
 *  4. the member's role holds every permission the route declares, else 403.
 * It then attaches the organisation, membership and effective permissions to the request.
 */
@Injectable()
export class OrgAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly organisations: OrganisationsService,
    private readonly memberships: MembershipsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    const slug = String(request.params.slug ?? '');
    const organisation = slug ? await this.organisations.findActiveBySlug(slug) : null;
    if (!organisation) {
      throw new NotFoundException('Organisation not found.');
    }

    const membership = await this.memberships.findWithRole(request.user.id, organisation.id);
    if (!membership?.role) {
      throw new ForbiddenException('You do not have access to this organisation.');
    }

    if (
      membership.role.scopeKind === RoleScopeKind.Event &&
      !this.reflector.getAllAndOverride<boolean | undefined>(EVENT_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      throw new ForbiddenException('Your access is limited to your events.');
    }

    const permissions = RolesService.effectivePermissions(membership.role);
    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (!holdsAll(permissions, required)) {
      throw new ForbiddenException('Your role does not allow this.');
    }

    request.access = { organisation, membership, permissions };
    return true;
  }
}
