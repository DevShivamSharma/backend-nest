import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MembershipEntity } from '../access/membership.entity';
import { MembershipsService } from '../access/memberships.service';
import { AuditService } from '../audit/audit.service';
import type { Actor, OrgAccessContext } from '../common/http/authenticated-request';
import { holdsAll } from '../roles/permissions';
import { OWNER_ROLE_KEY } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import type { MemberView } from './team.views';

/**
 * Changes to an organisation's members. Two rules guard every change: nobody acts on a member
 * who holds permissions they lack, and the last owner (Venue Admin) cannot be removed.
 */
@Injectable()
export class TeamService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly memberships: MembershipsService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  async list(organisationId: string): Promise<MemberView[]> {
    const rows = await this.memberships.listForOrganisation(organisationId);
    return rows.map(TeamService.view);
  }

  async changeRole(
    access: OrgAccessContext,
    membershipId: string,
    roleId: string,
    actor: Actor,
  ): Promise<MemberView> {
    const organisationId = access.organisation.id;
    const role = await this.roles.getForOrganisation(organisationId, roleId);
    const refusal = RolesService.grantCheck(access.permissions, role);
    if (refusal) {
      throw new ForbiddenException(refusal);
    }

    await this.dataSource.transaction(async (em) => {
      const member = await this.memberships.getInOrganisation(organisationId, membershipId, em);
      this.assertCanActOn(access, member);
      if (member.roleId === role.id) {
        return;
      }
      if (role.key !== OWNER_ROLE_KEY || role.organisationId !== null) {
        await this.memberships.assertNotLastOwner(em, member);
      }

      // An organisation role covers the whole organisation: no event scope left behind.
      await em
        .getRepository(MembershipEntity)
        .update({ id: member.id }, { roleId: role.id, scope: {} });
      await this.audit.record(
        {
          action: 'membership.role_changed',
          actor,
          organisationId,
          targetType: 'membership',
          targetId: member.id,
          metadata: { email: member.user!.email, from: member.role!.key, to: role.key },
        },
        em,
      );
    });

    return TeamService.view(await this.memberships.getInOrganisation(organisationId, membershipId));
  }

  async remove(access: OrgAccessContext, membershipId: string, actor: Actor): Promise<void> {
    const organisationId = access.organisation.id;
    await this.dataSource.transaction(async (em) => {
      const member = await this.memberships.getInOrganisation(organisationId, membershipId, em);
      this.assertCanActOn(access, member);
      await this.memberships.assertNotLastOwner(em, member);

      await em.getRepository(MembershipEntity).delete({ id: member.id });
      await this.audit.record(
        {
          action: 'membership.removed',
          actor,
          organisationId,
          targetType: 'membership',
          targetId: member.id,
          metadata: { email: member.user!.email, role: member.role!.key },
        },
        em,
      );
    });
  }

  private assertCanActOn(access: OrgAccessContext, member: MembershipEntity): void {
    if (!holdsAll(access.permissions, RolesService.effectivePermissions(member.role!))) {
      throw new ForbiddenException('This member has permissions you do not have.');
    }
  }

  static view(membership: MembershipEntity): MemberView {
    const user = membership.user!;
    return {
      id: membership.id,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      role: RolesService.ref(membership.role!),
      scope: membership.scope,
      joinedAt: membership.createdAt.toISOString(),
    };
  }
}
