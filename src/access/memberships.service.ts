import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { OrganisationStatus } from '../organisations/organisation.entity';
import { OWNER_ROLE_KEY } from '../roles/role.entity';
import { MembershipScope } from './membership-scope';
import { MembershipEntity } from './membership.entity';

@Injectable()
export class MembershipsService {
  constructor(
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
  ) {}

  /** The user's membership in the organisation, with its role. */
  findWithRole(userId: string, organisationId: string): Promise<MembershipEntity | null> {
    return this.memberships.findOne({
      where: { userId, organisationId },
      relations: { role: true },
    });
  }

  /** Memberships of active organisations only: a suspended one is not offered in the switcher. */
  listForUser(userId: string): Promise<MembershipEntity[]> {
    return this.memberships.find({
      where: { userId, organisation: { status: OrganisationStatus.Active } },
      relations: { organisation: true, role: true },
      order: { organisation: { name: 'ASC' } },
    });
  }

  listForOrganisation(organisationId: string): Promise<MembershipEntity[]> {
    return this.memberships.find({
      where: { organisationId },
      relations: { user: true, role: true },
      order: { user: { name: 'ASC' } },
    });
  }

  async getInOrganisation(
    organisationId: string,
    membershipId: string,
    manager?: EntityManager,
  ): Promise<MembershipEntity> {
    const membership = await this.repo(manager).findOne({
      where: { id: membershipId, organisationId },
      relations: { user: true, role: true },
    });
    if (!membership) {
      throw new NotFoundException('Member not found.');
    }
    return membership;
  }

  countForOrganisation(organisationId: string, manager?: EntityManager): Promise<number> {
    return this.repo(manager).countBy({ organisationId });
  }

  /** Gives the user the role, or changes the role of an existing membership. */
  async upsert(
    manager: EntityManager,
    input: { userId: string; organisationId: string; roleId: string; scope: MembershipScope },
  ): Promise<MembershipEntity> {
    const repo = this.repo(manager);
    const existing = await repo.findOneBy({
      userId: input.userId,
      organisationId: input.organisationId,
    });
    if (existing) {
      existing.roleId = input.roleId;
      existing.scope = input.scope;
      return repo.save(existing);
    }
    return repo.save(repo.create(input));
  }

  /**
   * Every organisation keeps at least one member in the locked owner role, so nobody can
   * lock the organisation out of its own team. Call inside the transaction that would remove
   * or demote `membership`.
   */
  async assertNotLastOwner(manager: EntityManager, membership: MembershipEntity): Promise<void> {
    if (membership.role?.key !== OWNER_ROLE_KEY || membership.role.organisationId !== null) {
      return;
    }
    // Lock the owners' rows so two admins cannot demote each other at the same moment.
    const owners = await manager
      .getRepository(MembershipEntity)
      .createQueryBuilder('m')
      .innerJoin('m.role', 'r')
      .where('m.organisationId = :organisationId', { organisationId: membership.organisationId })
      .andWhere('r.key = :key AND r.organisationId IS NULL', { key: OWNER_ROLE_KEY })
      .setLock('pessimistic_write', undefined, ['m'])
      .getMany();
    if (owners.length <= 1) {
      throw new ConflictException(
        `${membership.role.name} is the last one in this organisation. Give the role to someone else first.`,
      );
    }
  }

  private repo(manager?: EntityManager): Repository<MembershipEntity> {
    return manager ? manager.getRepository(MembershipEntity) : this.memberships;
  }
}
