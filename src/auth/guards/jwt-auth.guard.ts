import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { RedisService } from '../../common/redis-service/redis.service';
import { AuthService } from '../services/auth.service';
import type { AccessTokenPayload, RequestSession, SessionUser } from '../domain/session-user';

const SESSION_ENDED = 'Your session has expired. Sign in again.';

/**
 * Applied to every route. A route needs a valid bearer token unless it is marked `@Public()`.
 * The checks are ITPO's own: the token verifies with ITPO's secret, its session id is the one in
 * Redis, and its roles match the roles cached there. The user is also looked up on each request,
 * so a switched-off account loses access at once.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: SessionUser; session?: RequestSession }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException(SESSION_ENDED);
    }
    if (!payload.id || !payload.sessionId) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    // The session in Redis must be this token's: signing out or in elsewhere replaces it.
    const storedSession = await this.redis.get(`session:${payload.id}`);
    if (!storedSession || storedSession !== payload.sessionId) {
      throw new UnauthorizedException(SESSION_ENDED);
    }
    const cachedRoles = await this.redis.get(`roles:${payload.id}`);
    if (!cachedRoles || !sameRoles(JSON.parse(cachedRoles) as string[], payload.role ?? [])) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    if (await this.auth.isSessionRevoked(payload.sessionId)) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    const user = await this.auth.findSessionUser(payload.id, payload.role ?? []);
    if (!user) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    request.user = user;
    request.session = {
      id: payload.sessionId,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
    return true;
  }
}

function sameRoles(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
