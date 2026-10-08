import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import type { MembershipScope } from '../access/membership-scope';
import { MembershipsService } from '../access/memberships.service';
import { AuditService } from '../audit/audit.service';
import { hashToken, randomToken } from '../common/crypto';
import type { Actor } from '../common/http/authenticated-request';
import { PASSWORD_MIN } from '../common/validation';
import { MailService } from '../mail/mail.service';
import { OrganisationEntity, OrganisationStatus } from '../organisations/organisation.entity';
import { RoleEntity } from '../roles/role.entity';
import { RolesService } from '../roles/roles.service';
import { PasswordService } from '../users/password.service';
import { UserEntity, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { invitationEmail } from './invitation-email';
import { InvitationEntity } from './invitation.entity';
import type { CreatedInvitationView, InvitationPreview, InvitationView } from './team.views';

const INVITATION_TTL_DAYS = 7;

export interface Granter {
  actor: Actor & { name: string };
  /** What the inviter holds; a role with more than this cannot be given. */
  permissions: readonly string[];
}

export interface AcceptInput {
  name?: string;
  password: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(InvitationEntity) private readonly invitations: Repository<InvitationEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly memberships: MembershipsService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Invites a person, replacing any open invitation they already have here. Pass `manager` to
   * run inside the caller's transaction (organisation creation); the email then goes out only
   * after that transaction commits, via the returned `send`.
   */
  async invite(
    organisation: OrganisationEntity,
    input: { email: string; roleId: string; scope?: MembershipScope },
    granter: Granter,
    manager?: EntityManager,
  ): Promise<{ view: CreatedInvitationView; send: () => Promise<void> }> {
    const scope = input.scope ?? {};
    const run = async (em: EntityManager) => {
      const role = await this.roleFor(em, organisation.id, input.roleId);
      const refusal = RolesService.grantCheck(
        granter.permissions,
        role,
        Boolean(scope.eventIds?.length),
      );
      if (refusal) {
        throw new ForbiddenException(refusal);
      }

      const email = UsersService.normaliseEmail(input.email);
      const existingUser = await this.users.findByEmail(email, em);
      if (existingUser) {
        const member = await this.memberships.findWithRole(existingUser.id, organisation.id);
        if (member) {
          throw new ConflictException(
            'This person is already a member. Change their role instead.',
          );
        }
      }

      await this.assertWithinUserLimit(em, organisation, email);

      const repo = em.getRepository(InvitationEntity);
      await repo.update(
        { organisationId: organisation.id, email, acceptedAt: IsNull(), revokedAt: IsNull() },
        { revokedAt: new Date() },
      );

      const token = randomToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
      const invitation = await repo.save(
        repo.create({
          organisationId: organisation.id,
          email,
          roleId: role.id,
          scope,
          tokenHash: hashToken(token),
          invitedById: granter.actor.id,
          expiresAt,
        }),
      );

      await this.audit.record(
        {
          action: 'invitation.created',
          actor: granter.actor,
          organisationId: organisation.id,
          targetType: 'invitation',
          targetId: invitation.id,
          metadata: { email, role: role.key },
        },
        em,
      );

      const link = this.mail.link(`/${organisation.slug}/accept-invite`, { token });
      const view: CreatedInvitationView = {
        ...InvitationsService.view(invitation, role, {
          name: granter.actor.name,
          email: granter.actor.email,
        }),
        inviteUrl: this.mail.deliversToLog ? link : null,
      };
      const send = () =>
        this.mail.send(
          invitationEmail({
            to: email,
            organisation,
            roleName: role.name,
            inviterName: granter.actor.name,
            link,
            expiresAt,
          }),
        );
      return { view, send };
    };

    if (manager) {
      return run(manager);
    }
    const result = await this.dataSource.transaction(run);
    await result.send();
    return result;
  }

  /** Open invitations, newest first; expired ones are listed so they can be sent again. */
  async listOpen(organisationId: string): Promise<InvitationView[]> {
    const rows = await this.invitations.find({
      where: { organisationId, acceptedAt: IsNull(), revokedAt: IsNull() },
      relations: { role: true, invitedBy: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => InvitationsService.view(row, row.role!, row.invitedBy ?? null));
  }

  /** A new link for the same person and role; the old link stops working. */
  async resend(
    organisation: OrganisationEntity,
    invitationId: string,
    granter: Granter,
  ): Promise<CreatedInvitationView> {
    const invitation = await this.getOpen(organisation.id, invitationId);
    const { view } = await this.invite(
      organisation,
      { email: invitation.email, roleId: invitation.roleId, scope: invitation.scope },
      granter,
    );
    return view;
  }

  async revoke(organisationId: string, invitationId: string, actor: Actor): Promise<void> {
    const invitation = await this.getOpen(organisationId, invitationId);
    await this.dataSource.transaction(async (em) => {
      await em
        .getRepository(InvitationEntity)
        .update({ id: invitation.id }, { revokedAt: new Date() });
      await this.audit.record(
        {
          action: 'invitation.revoked',
          actor,
          organisationId,
          targetType: 'invitation',
          targetId: invitation.id,
          metadata: { email: invitation.email },
        },
        em,
      );
    });
  }

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findOpenByToken(this.dataSource.manager, token, false);
    const user = await this.users.findWithPasswordByEmail(invitation.email);
    return {
      organisation: { slug: invitation.organisation!.slug, name: invitation.organisation!.name },
      email: invitation.email,
      role: RolesService.ref(invitation.role!),
      accountExists: Boolean(user?.passwordHash),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Accepts an invitation. A person with an account proves it with their password; a new one
   * chooses a name and password. Either way they become a member with the invited role.
   */
  async accept(
    token: string,
    input: AcceptInput,
    ip: string | null,
  ): Promise<{ user: UserEntity; organisation: OrganisationEntity }> {
    return this.dataSource.transaction(async (em) => {
      const invitation = await this.findOpenByToken(em, token, true);
      const organisation = invitation.organisation!;

      let user = await this.users.findWithPasswordByEmail(invitation.email, em);
      if (user?.passwordHash) {
        if (!(await this.passwords.verify(user.passwordHash, input.password))) {
          throw new UnauthorizedException('The password is not correct for this account.');
        }
      } else {
        const name = input.name?.trim();
        if (!name) {
          throw new BadRequestException('Enter your name.');
        }
        if (input.password.length < PASSWORD_MIN) {
          throw new BadRequestException(
            `Use at least ${PASSWORD_MIN} characters for your password.`,
          );
        }
        const passwordHash = await this.passwords.hash(input.password);
        if (user) {
          await this.users.setPassword(user.id, passwordHash, name, em);
        } else {
          user = await this.users.create({ email: invitation.email, name, passwordHash }, em);
        }
      }

      if (user.status !== UserStatus.Active) {
        throw new ForbiddenException('This account is disabled. Contact the platform team.');
      }

      await this.memberships.upsert(em, {
        userId: user.id,
        organisationId: organisation.id,
        roleId: invitation.roleId,
        scope: invitation.scope,
      });
      await em
        .getRepository(InvitationEntity)
        .update({ id: invitation.id }, { acceptedAt: new Date() });

      await this.audit.record(
        {
          action: 'invitation.accepted',
          actor: { id: user.id, email: user.email },
          organisationId: organisation.id,
          targetType: 'invitation',
          targetId: invitation.id,
          metadata: { role: invitation.role!.key },
          ip,
        },
        em,
      );

      const fresh = await this.users.findByEmail(user.email, em);
      return { user: fresh ?? user, organisation };
    });
  }

  private async findOpenByToken(
    em: EntityManager,
    token: string,
    lock: boolean,
  ): Promise<InvitationEntity> {
    const qb = em
      .getRepository(InvitationEntity)
      .createQueryBuilder('invitation')
      .innerJoinAndSelect('invitation.organisation', 'organisation')
      .innerJoinAndSelect('invitation.role', 'role')
      .where('invitation.tokenHash = :hash', { hash: hashToken(token) });
    if (lock) {
      qb.setLock('pessimistic_write', undefined, ['invitation']);
    }
    const invitation = await qb.getOne();

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.organisation?.status !== OrganisationStatus.Active
    ) {
      throw new NotFoundException('This invitation is no longer valid. Ask for a new one.');
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This invitation has expired. Ask for a new one.');
    }
    return invitation;
  }

  private async getOpen(organisationId: string, invitationId: string): Promise<InvitationEntity> {
    const invitation = await this.invitations.findOneBy({
      id: invitationId,
      organisationId,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found.');
    }
    return invitation;
  }

  private async roleFor(
    em: EntityManager,
    organisationId: string,
    roleId: string,
  ): Promise<RoleEntity> {
    const role = await em.getRepository(RoleEntity).findOne({
      where: [
        { id: roleId, organisationId: IsNull() },
        { id: roleId, organisationId },
      ],
    });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    return role;
  }

  /** Members plus open invitations (other than this person's, which is about to be replaced). */
  private async assertWithinUserLimit(
    em: EntityManager,
    organisation: OrganisationEntity,
    email: string,
  ): Promise<void> {
    const members = await this.memberships.countForOrganisation(organisation.id, em);
    const open = await em
      .getRepository(InvitationEntity)
      .createQueryBuilder('i')
      .where('i.organisationId = :id', { id: organisation.id })
      .andWhere('i.acceptedAt IS NULL AND i.revokedAt IS NULL')
      .andWhere('i.expiresAt > now()')
      .andWhere('i.email <> :email', { email })
      .getCount();

    if (members + open >= organisation.limits.users) {
      throw new ForbiddenException(
        `${organisation.name} has reached its limit of ${organisation.limits.users} users. ` +
          'Ask the platform team to raise it.',
      );
    }
  }

  static view(
    invitation: InvitationEntity,
    role: RoleEntity,
    invitedBy: { name: string; email: string } | null,
  ): InvitationView {
    return {
      id: invitation.id,
      email: invitation.email,
      role: RolesService.ref(role),
      invitedBy: invitedBy ? { name: invitedBy.name, email: invitedBy.email } : null,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= Date.now(),
    };
  }
}
