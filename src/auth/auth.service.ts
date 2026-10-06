import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { MembershipsService } from '../access/memberships.service';
import { AuditService } from '../audit/audit.service';
import { hashToken, randomToken } from '../common/crypto';
import type { ClientInfo } from '../common/http/authenticated-request';
import { MailService } from '../mail/mail.service';
import { OrganisationsService } from '../organisations/organisations.service';
import { RolesService } from '../roles/roles.service';
import { InvitationsService } from '../team/invitations.service';
import { PasswordService } from '../users/password.service';
import { UserEntity, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import type { AcceptedInvitationView, MeView, SessionView, UserView } from './auth.views';
import { AcceptInvitationDto } from './dto/auth.dto';
import { PasswordResetTokenEntity } from './password-reset-token.entity';
import { IssuedRefresh, TokensService } from './tokens.service';

const RESET_TTL_MS = 60 * 60 * 1000;
const INVALID_CREDENTIALS = 'Email or password is incorrect.';

export interface SignedIn<T extends SessionView = SessionView> {
  session: T;
  refresh: IssuedRefresh;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly memberships: MembershipsService,
    private readonly organisations: OrganisationsService,
    private readonly invitations: InvitationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, client: ClientInfo): Promise<SignedIn> {
    const user = await this.users.findWithPasswordByEmail(email);
    const valid = await this.passwords.verify(user?.passwordHash ?? null, password);

    if (!user || !valid) {
      if (user) {
        await this.audit.record({
          action: 'auth.login_failed',
          actor: { id: user.id, email: user.email },
          ip: client.ip,
        });
      }
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (user.status !== UserStatus.Active) {
      throw new UnauthorizedException('This account is disabled. Contact the platform team.');
    }

    await this.users.recordLogin(user.id);
    await this.audit.record({
      action: 'auth.login',
      actor: { id: user.id, email: user.email },
      ip: client.ip,
    });
    return this.startSession(user, client);
  }

  async refresh(token: string, client: ClientInfo): Promise<SignedIn> {
    const { userId, refresh } = await this.tokens.rotate(token, client);
    const user = await this.users.findActiveById(userId);
    if (!user) {
      await this.tokens.revokeAllForUser(userId);
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
    return { session: await this.session(user), refresh };
  }

  logout(token: string): Promise<void> {
    return this.tokens.revokeFamilyOf(token);
  }

  async me(user: UserView): Promise<MeView> {
    const memberships = await this.memberships.listForUser(user.id);
    return {
      user,
      memberships: memberships.map((membership) => ({
        id: membership.id,
        organisation: {
          id: membership.organisation!.id,
          slug: membership.organisation!.slug,
          name: membership.organisation!.name,
        },
        role: RolesService.ref(membership.role!),
      })),
    };
  }

  async acceptInvitation(
    token: string,
    dto: AcceptInvitationDto,
    client: ClientInfo,
  ): Promise<SignedIn<AcceptedInvitationView>> {
    const { user, organisation } = await this.invitations.accept(token, dto, client.ip);
    await this.users.recordLogin(user.id);
    const { session, refresh } = await this.startSession(user, client);
    return { session: { ...session, organisationSlug: organisation.slug }, refresh };
  }

  /**
   * Always succeeds from the caller's view, so it cannot be used to find out who has an
   * account. The link opens in the look of the organisation whose page asked for it.
   */
  async forgotPassword(email: string, orgSlug?: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.status !== UserStatus.Active) {
      return;
    }

    const base = await this.resetLinkBase(user, orgSlug);
    const token = randomToken();
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(PasswordResetTokenEntity);
      await repo.update({ userId: user.id, usedAt: IsNull() }, { usedAt: new Date() });
      await repo.insert({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
    });

    await this.mail.send({
      to: user.email,
      subject: 'Reset your password',
      text: [
        `Hello ${user.name},`,
        '',
        `Choose a new password here: ${this.mail.link(`${base}/reset-password`, { token })}`,
        '',
        'The link works once, for one hour. If you did not ask for it, ignore this email.',
      ].join('\n'),
    });
  }

  /** Sets the new password and signs the user out on every device. */
  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(PasswordResetTokenEntity);
      const row = await repo.findOne({
        where: { tokenHash: hashToken(token) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('This reset link is no longer valid. Ask for a new one.');
      }

      await repo.update({ id: row.id }, { usedAt: new Date() });
      await this.users.setPassword(row.userId, passwordHash, undefined, em);
      await this.tokens.revokeAllForUser(row.userId, em);

      const user = await em.getRepository(UserEntity).findOneByOrFail({ id: row.userId });
      await this.audit.record(
        {
          action: 'auth.password_reset',
          actor: { id: user.id, email: user.email },
          ip: client.ip,
        },
        em,
      );
    });
  }

  private async startSession(user: UserEntity, client: ClientInfo): Promise<SignedIn> {
    const refresh = await this.tokens.issueRefresh(user.id, client);
    return { session: await this.session(user), refresh };
  }

  private async session(user: UserEntity): Promise<SessionView> {
    return {
      accessToken: await this.tokens.signAccess(user.id),
      expiresIn: this.tokens.accessTtlSeconds,
      user: AuthService.userView(user),
    };
  }

  private async resetLinkBase(user: UserEntity, orgSlug?: string): Promise<string> {
    if (orgSlug) {
      const organisation = await this.organisations.findActiveBySlug(orgSlug);
      if (organisation) {
        return `/${organisation.slug}`;
      }
    }
    if (user.isPlatformAdmin) {
      return '/admin';
    }
    const [first] = await this.memberships.listForUser(user.id);
    return first ? `/${first.organisation!.slug}` : '/admin';
  }

  static userView(user: UserEntity): UserView {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
    };
  }
}
