import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import ms, { type StringValue } from 'ms';
import { DataSource } from 'typeorm';

import type { AllConfigType } from '../../config/config.type';
import { RedisService } from '../../common/redis-service/redis.service';
import type { AccessTokenPayload, RefreshTokenPayload, SessionUser } from '../domain/session-user';
import { userTypeOf } from '../domain/user-type';

export interface TokenResult {
  accessToken: string;
  /** Epoch milliseconds, as ITPO's own sign-in reports it. */
  tokenExpires: number;
  user: SessionUser;
}

export interface LoginResult extends TokenResult {
  refreshToken: string;
}

/** The columns of ITPO's `T_USER` this app reads. */
interface UserRow {
  id: string;
  username: string | null;
  email: string | null;
  password: string | null;
  isActive: boolean;
  org_id: string | null;
  /** `T_ORGANIZATION.name` of `org_id`, joined in by the queries. */
  organisation_name: string | null;
}

const INVALID_LOGIN = 'Invalid email or password.';
const SESSION_ENDED = 'Your session has expired. Sign in again.';

// A real-shaped bcrypt hash of a throwaway string, so an unknown email costs the same time as a
// wrong password and cannot be told apart by timing.
const DUMMY_HASH = '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BWmzkQNsm8vC/2fVcpG6s5hv0p0e';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DataSource,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  async login(email: string, password: string, ip: string | null): Promise<LoginResult> {
    // ITPO's table: a live row is one that is not soft-deleted.
    const [user] = await this.db.query<UserRow[]>(
      `SELECT u.id, u.username, u.email, u.password, u."isActive", u.org_id, o.name AS organisation_name
         FROM idp."T_USER" u
         LEFT JOIN idp."T_ORGANIZATION" o ON o.id = u.org_id
        WHERE LOWER(u.email) = $1 AND u."deletedAt" IS NULL
        ORDER BY u."isActive" DESC, u."createdAt" DESC
        LIMIT 1`,
      [email],
    );

    // The same refusal for an unknown email, a wrong password and a switched-off account.
    const passwordOk = await compare(password, user?.password ?? DUMMY_HASH);
    if (!user || !user.password || !passwordOk || !user.isActive) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    // As ITPO's own sign-in does: note when and from where the user last came in.
    await this.db.query(
      `UPDATE idp."T_USER" SET "last_login_date" = NOW(), "last_login_ip" = $1 WHERE id = $2`,
      [ip, user.id],
    );

    const roles = await this.rolesOf(user.id);
    const sessionId = randomStringGenerator();
    const { token, expiresAt } = await this.issueToken(user, roles, sessionId);

    // ITPO's refresh claims (`sessionId`, `hash`), plus the user, which a refresh needs to find.
    const refreshPayload: RefreshTokenPayload = {
      id: user.id,
      sessionId,
      hash: createHash('sha256').update(randomStringGenerator()).digest('hex'),
    };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.configService.getOrThrow('auth.refreshSecret', { infer: true }),
      expiresIn: this.configService.getOrThrow('auth.refreshExpires', {
        infer: true,
      }) as JwtSignOptions['expiresIn'],
    });

    return {
      accessToken: token,
      refreshToken,
      tokenExpires: expiresAt.getTime(),
      user: toSessionUser(user, roles),
    };
  }

  /**
   * A new access token for the same session, in exchange for its refresh token. Refused once the
   * refresh token has expired or the account is switched off.
   */
  async refresh(refreshToken: string): Promise<TokenResult> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow('auth.refreshSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    if (!payload.id || !payload.sessionId || (await this.isSessionRevoked(payload.sessionId))) {
      throw new UnauthorizedException(SESSION_ENDED);
    }
    // The session ITPO's apps know of must still be this one (not signed out, not replaced).
    if ((await this.redis.get(`session:${payload.id}`)) !== payload.sessionId) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    const [user] = await this.db.query<UserRow[]>(
      `SELECT u.id, u.username, u.email, u."isActive", u.org_id, o.name AS organisation_name
         FROM idp."T_USER" u
         LEFT JOIN idp."T_ORGANIZATION" o ON o.id = u.org_id
        WHERE u.id = $1 AND u."isActive" = true AND u."deletedAt" IS NULL`,
      [payload.id],
    );
    if (!user) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    const roles = await this.rolesOf(user.id);
    const { token, expiresAt } = await this.issueToken(user, roles, payload.sessionId);

    return {
      accessToken: token,
      tokenExpires: expiresAt.getTime(),
      user: toSessionUser(user, roles),
    };
  }

  /** The user a valid token names, if they may still sign in. */
  async findSessionUser(id: string, roles: string[]): Promise<SessionUser | null> {
    const [user] = await this.db.query<UserRow[]>(
      `SELECT u.id, u.username, u.email, u."isActive", u.org_id, o.name AS organisation_name
         FROM idp."T_USER" u
         LEFT JOIN idp."T_ORGANIZATION" o ON o.id = u.org_id
        WHERE u.id = $1 AND u."isActive" = true AND u."deletedAt" IS NULL`,
      [id],
    );

    return user ? toSessionUser(user, roles) : null;
  }

  /**
   * Signs the session out: its access and refresh tokens are refused from now on. The record is
   * kept only as long as the refresh token could still have been used.
   */
  async logout(userId: string, sessionId: string): Promise<void> {
    const keepFor = ms(
      this.configService.getOrThrow('auth.refreshExpires', { infer: true }) as StringValue,
    );
    await this.db.query(
      `INSERT INTO idp."T_AUTH_REVOKED_SESSION" (session_id, user_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, userId, String(keepFor)],
    );
    await this.db.query(`DELETE FROM idp."T_AUTH_REVOKED_SESSION" WHERE expires_at < NOW()`);

    // And where ITPO's apps look: its session keys in Redis and the user's stored token.
    await this.redis.del(`roles:${userId}`);
    await this.redis.del(`session:${userId}`);
    await this.db.query(`DELETE FROM idp."T_AUTH_TOKEN" WHERE user_id = $1`, [userId]);
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    const rows = await this.db.query<unknown[]>(
      `SELECT 1 FROM idp."T_AUTH_REVOKED_SESSION" WHERE session_id = $1`,
      [sessionId],
    );
    return rows.length > 0;
  }

  private async rolesOf(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ slug: string }[]>(
      `SELECT c.slug
         FROM idp."T_USERS_ROLES" ur
         JOIN idp."T_CODE_MASTER" c ON c.id = ur.role_id
        WHERE ur.user_id = $1`,
      [userId],
    );

    return rows.map((r) => r.slug);
  }

  /** Signs the access token with the claims ITPO's apps use: id, role, sessionId, orgId. */
  private async issueToken(
    user: UserRow,
    roles: string[],
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const payload: AccessTokenPayload = {
      id: user.id,
      role: roles,
      sessionId,
      orgId: user.org_id,
    };

    const token = await this.jwt.signAsync(payload);
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    const expiresAt = new Date(exp * 1000);

    // So that ITPO's own services accept this token as they do their own: the session and roles
    // in Redis, and the token in T_AUTH_TOKEN (one row per user). One session per user: this
    // replaces one opened in an ITPO app, and the other way round.
    const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await this.redis.del(`session:${user.id}`);
    await this.redis.set(`session:${user.id}`, sessionId);
    await this.redis.set(`roles:${user.id}`, JSON.stringify(roles), ttlSeconds);
    await this.db.query(
      `INSERT INTO idp."T_AUTH_TOKEN" (user_id, token, expiry, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET token = EXCLUDED.token, expiry = EXCLUDED.expiry, "updatedAt" = NOW()`,
      [user.id, token, expiresAt],
    );

    return { token, expiresAt };
  }
}

function toSessionUser(user: UserRow, roles: string[]): SessionUser {
  return {
    id: user.id,
    email: user.email ?? '',
    name: user.username ?? user.email ?? '',
    type: userTypeOf(user.org_id),
    roles,
    orgId: user.org_id,
    organisationName: user.organisation_name,
  };
}
