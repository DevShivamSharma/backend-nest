import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { hashToken, randomToken } from '../common/crypto';
import type { ClientInfo } from '../common/http/authenticated-request';
import type { AuthConfig } from '../config/configuration';
import { RefreshTokenEntity } from './refresh-token.entity';

export const JWT_ISSUER = 'venue-platform';
export const JWT_AUDIENCE = 'venue-platform-web';

/**
 * A replaced refresh token presented within this window is a race between two tabs, not theft:
 * the cookie jar already holds the newer token, so the client simply retries.
 */
const ROTATION_GRACE_MS = 30_000;

export interface AccessPayload {
  sub: string;
}

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
}

type RotationOutcome =
  | { kind: 'rotated'; userId: string; refresh: IssuedRefresh }
  | { kind: 'race' }
  | { kind: 'invalid' }
  | { kind: 'reused' };

@Injectable()
export class TokensService {
  private readonly auth: AuthConfig;

  constructor(
    private readonly jwt: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  get accessTtlSeconds(): number {
    return this.auth.accessTtlSeconds;
  }

  signAccess(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId } satisfies AccessPayload);
  }

  async verifyAccess(token: string): Promise<AccessPayload | null> {
    try {
      return await this.jwt.verifyAsync<AccessPayload>(token, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      return null;
    }
  }

  /** Starts a new session family, or continues `familyId` after a rotation. */
  async issueRefresh(
    userId: string,
    client: ClientInfo,
    manager?: EntityManager,
    familyId: string = randomUUID(),
  ): Promise<IssuedRefresh & { id: string }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.auth.refreshTtlDays * 24 * 60 * 60 * 1000);
    const repo = (manager ?? this.dataSource.manager).getRepository(RefreshTokenEntity);
    const row = await repo.save(
      repo.create({
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt,
        userAgent: client.userAgent,
        ip: client.ip,
      }),
    );
    return { id: row.id, token, expiresAt };
  }

  /**
   * Swaps a refresh token for a new one. A token that was already swapped (outside the race
   * window) means it was copied: the whole session family is revoked.
   */
  async rotate(
    token: string,
    client: ClientInfo,
  ): Promise<{ userId: string; refresh: IssuedRefresh }> {
    const outcome = await this.dataSource.transaction(async (em): Promise<RotationOutcome> => {
      const repo = em.getRepository(RefreshTokenEntity);
      const row = await repo.findOne({
        where: { tokenHash: hashToken(token) },
        lock: { mode: 'pessimistic_write' },
      });

      if (!row || row.expiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid' };
      }
      if (row.revokedAt) {
        const race =
          row.replacedById !== null && Date.now() - row.revokedAt.getTime() < ROTATION_GRACE_MS;
        if (race) {
          return { kind: 'race' };
        }
        await repo.update(
          { familyId: row.familyId, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
        return { kind: 'reused' };
      }

      const next = await this.issueRefresh(row.userId, client, em, row.familyId);
      await repo.update({ id: row.id }, { revokedAt: new Date(), replacedById: next.id });
      return { kind: 'rotated', userId: row.userId, refresh: next };
    });

    switch (outcome.kind) {
      case 'rotated':
        return { userId: outcome.userId, refresh: outcome.refresh };
      case 'race':
        throw new ConflictException('Your session is being refreshed. Try again.');
      default:
        throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
  }

  /** Ends the session the token belongs to, on this device only. */
  async revokeFamilyOf(token: string): Promise<void> {
    const repo = this.dataSource.getRepository(RefreshTokenEntity);
    const row = await repo.findOneBy({ tokenHash: hashToken(token) });
    if (row) {
      await repo.update({ familyId: row.familyId, revokedAt: IsNull() }, { revokedAt: new Date() });
    }
  }

  /** Signs the user out everywhere, as after a password change. */
  async revokeAllForUser(userId: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.dataSource.manager)
      .getRepository(RefreshTokenEntity)
      .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
