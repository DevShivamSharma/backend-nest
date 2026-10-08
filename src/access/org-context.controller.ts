import { Controller, Get } from '@nestjs/common';

import type { OrgAccessContext } from '../common/http/authenticated-request';
import type { BookingMode, OrganisationFeatures } from '../organisations/organisation-config';
import type { Permission } from '../roles/permissions';
import { RoleScopeKind } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import type { RoleRef } from '../roles/role.views';
import type { MembershipScope } from './membership-scope';
import { AllowEventRoles, CurrentAccess, OrgAccess } from './org-access.decorators';

export interface OrgContextView {
  organisation: {
    id: string;
    slug: string;
    name: string;
    bookingMode: BookingMode;
    features: OrganisationFeatures;
  };
  /** `eventScoped`: an organiser, who sees only the events in `scope`. */
  membership: { id: string; role: RoleRef; scope: MembershipScope; eventScoped: boolean };
  /** What the signed-in member may do here; the app shows only what these allow. */
  permissions: readonly Permission[];
}

@OrgAccess()
@AllowEventRoles()
@Controller('orgs/:slug/context')
export class OrgContextController {
  @Get()
  get(@CurrentAccess() access: OrgAccessContext): OrgContextView {
    const { organisation, membership, permissions } = access;
    return {
      organisation: {
        id: organisation.id,
        slug: organisation.slug,
        name: organisation.name,
        bookingMode: organisation.bookingMode,
        features: organisation.features,
      },
      membership: {
        id: membership.id,
        role: RolesService.ref(membership.role!),
        scope: membership.scope,
        eventScoped: membership.role!.scopeKind === RoleScopeKind.Event,
      },
      permissions,
    };
  }
}
