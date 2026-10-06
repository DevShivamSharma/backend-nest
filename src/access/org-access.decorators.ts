import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedRequest, OrgAccessContext } from '../common/http/authenticated-request';
import type { Permission } from '../roles/permissions';
import { OrgAccessGuard, REQUIRED_PERMISSIONS_KEY } from './org-access.guard';

/**
 * Members only, holding every listed permission. On a controller, applies to all its routes; a
 * route can declare its own list, which then replaces the controller's.
 */
export const OrgAccess = (...permissions: Permission[]) =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions), UseGuards(OrgAccessGuard));

/** Declares the permissions of one route under a controller that already has `@OrgAccess()`. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/** The organisation, membership and permissions the guard established. */
export const CurrentAccess = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): OrgAccessContext => {
    const access = ctx.switchToHttp().getRequest<AuthenticatedRequest>().access;
    if (!access) {
      throw new Error('CurrentAccess used on a route without @OrgAccess().');
    }
    return access;
  },
);
