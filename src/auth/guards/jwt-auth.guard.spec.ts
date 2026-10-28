import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';

import type { RedisService } from '../../common/redis-service/redis.service';
import type { AuthService } from '../services/auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserType } from '../domain/user-type';

interface World {
  claims?: Record<string, unknown> | null;
  session?: string | null;
  roles?: string | null;
  revoked?: boolean;
  active?: boolean;
}

function build(world: World = {}) {
  const claims =
    world.claims === undefined
      ? { id: 'u1', role: ['itpo_admin'], sessionId: 's1', orgId: null, exp: 2_000_000_000 }
      : world.claims;
  const redisStore: Record<string, string | null> = {
    'session:u1': world.session === undefined ? 's1' : world.session,
    'roles:u1': world.roles === undefined ? JSON.stringify(['itpo_admin']) : world.roles,
  };
  const jwt = {
    verifyAsync: () => (claims ? Promise.resolve(claims) : Promise.reject(new Error('bad'))),
  } as unknown as JwtService;
  const redis = {
    get: (key: string) => Promise.resolve(redisStore[key] ?? null),
  } as unknown as RedisService;
  const auth = {
    isSessionRevoked: () => Promise.resolve(world.revoked === true),
    findSessionUser: () =>
      Promise.resolve(
        world.active === false
          ? null
          : {
              id: 'u1',
              email: '',
              name: '',
              type: UserType.ItpoStaff,
              roles: ['itpo_admin'],
              orgId: null,
            },
      ),
  } as unknown as AuthService;
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;

  const request: { headers: Record<string, string>; user?: unknown; session?: unknown } = {
    headers: { authorization: 'Bearer token' },
  };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { guard: new JwtAuthGuard(reflector, jwt, redis, auth), context, request };
}

describe('JwtAuthGuard', () => {
  it("lets a token through whose session and roles ITPO's Redis holds", async () => {
    const { guard, context, request } = build();

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.user).toMatchObject({ id: 'u1', type: UserType.ItpoStaff });
    expect(request.session).toMatchObject({ id: 's1' });
  });

  it('refuses a request with no bearer token', async () => {
    const { guard, context, request } = build();
    request.headers = {};

    await expect(guard.canActivate(context)).rejects.toThrow('Sign in to continue.');
  });

  it.each([
    ['a token that does not verify', { claims: null }],
    ['a token without a session id', { claims: { id: 'u1', role: [] } }],
    ["a session ITPO's Redis does not hold (signed out)", { session: null }],
    ['a session another sign-in replaced', { session: 'someone-elses' }],
    ['no roles cached in Redis', { roles: null }],
    [
      'roles that differ from the cached ones (tampered)',
      { roles: JSON.stringify(['system_admin']) },
    ],
    ['a revoked session', { revoked: true }],
    ['a switched-off account', { active: false }],
  ] as [string, World][])('refuses %s', async (_label, world) => {
    const { guard, context } = build(world);

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('compares roles whatever their order', async () => {
    const { guard, context } = build({
      claims: { id: 'u1', role: ['b', 'a'], sessionId: 's1', orgId: null, exp: 2_000_000_000 },
      roles: JSON.stringify(['a', 'b']),
    });

    expect(await guard.canActivate(context)).toBe(true);
  });
});
