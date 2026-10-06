import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../common/http/authenticated-request';
import type { OrganisationsService } from '../organisations/organisations.service';
import { RoleEntity, RoleScopeKind } from '../roles/role.entity';
import type { MembershipEntity } from './membership.entity';
import type { MembershipsService } from './memberships.service';
import { OrgAccessGuard } from './org-access.guard';

describe('OrgAccessGuard', () => {
  const organisation = { id: 'o1', slug: 'itpo' };
  const findActiveBySlug = jest.fn();
  const findWithRole = jest.fn();
  const reflector = new Reflector();
  const guard = new OrgAccessGuard(
    reflector,
    { findActiveBySlug } as unknown as OrganisationsService,
    { findWithRole } as unknown as MembershipsService,
  );

  function context(
    request: Partial<AuthenticatedRequest>,
    required: string[] = [],
  ): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  function membership(permissions: string[]): MembershipEntity {
    const role = Object.assign(new RoleEntity(), {
      key: 'r',
      permissions,
      isLocked: false,
      scopeKind: RoleScopeKind.Organisation,
    });
    return { id: 'm1', role } as MembershipEntity;
  }

  const user = { id: 'u1', email: 'a@b.test', name: 'A', isPlatformAdmin: false };

  beforeEach(() => {
    findActiveBySlug.mockReset().mockResolvedValue(organisation);
    findWithRole.mockReset();
  });

  it('requires a signed-in user', async () => {
    await expect(guard.canActivate(context({ params: { slug: 'itpo' } }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('answers 404 for an unknown or suspended organisation', async () => {
    findActiveBySlug.mockResolvedValue(null);
    await expect(
      guard.canActivate(context({ user, params: { slug: 'nope' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 403 for a non-member, the Super Admin included', async () => {
    findWithRole.mockResolvedValue(null);
    await expect(
      guard.canActivate(
        context({ user: { ...user, isPlatformAdmin: true }, params: { slug: 'itpo' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 403 when the role lacks a required permission', async () => {
    findWithRole.mockResolvedValue(membership(['team.view']));
    await expect(
      guard.canActivate(context({ user, params: { slug: 'itpo' } }, ['team.invite'])),
    ).rejects.toThrow('Your role does not allow this.');
  });

  it('attaches the organisation, membership and permissions', async () => {
    const member = membership(['team.view', 'team.invite']);
    findWithRole.mockResolvedValue(member);
    const request: Partial<AuthenticatedRequest> = { user, params: { slug: 'itpo' } };

    await expect(guard.canActivate(context(request, ['team.invite']))).resolves.toBe(true);
    expect(request.access).toEqual({
      organisation,
      membership: member,
      permissions: ['team.view', 'team.invite'],
    });
  });
});
