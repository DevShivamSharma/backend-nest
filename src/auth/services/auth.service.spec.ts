import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hashSync } from 'bcryptjs';
import type { DataSource } from 'typeorm';

import type { RedisService } from '../../common/redis-service/redis.service';
import { AuthService } from './auth.service';
import { UserType } from '../domain/user-type';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    username: 'Asha',
    email: 'asha@itpo.test',
    password: hashSync('correct horse', 4),
    isActive: true,
    org_id: null,
    organisation_name: null,
    ...overrides,
  };
}

const revoked = new Set<string>();
let refreshClaims: Record<string, unknown> = {};

function build(found: Record<string, unknown> | null, roles: string[] = ['itpo_admin']) {
  const sql: { text: string; params: unknown[] }[] = [];
  const db = {
    query: (text: string, params: unknown[]) => {
      sql.push({ text, params });
      if (text.includes('FROM idp."T_USER"')) return Promise.resolve(found ? [found] : []);
      if (text.includes('"T_USERS_ROLES"')) return Promise.resolve(roles.map((slug) => ({ slug })));
      if (text.includes('SELECT 1 FROM idp."T_AUTH_REVOKED_SESSION"'))
        return Promise.resolve(revoked.has(params[0] as string) ? [{}] : []);
      if (text.includes('INSERT INTO idp."T_AUTH_REVOKED_SESSION"'))
        revoked.add(params[0] as string);
      return Promise.resolve([]);
    },
  } as unknown as DataSource;

  const signed: unknown[] = [];
  const jwt = {
    signAsync: (payload: unknown, options?: { secret?: string }) => {
      signed.push(payload);
      return Promise.resolve(options?.secret ? 'refresh-token' : 'token');
    },
    verifyAsync: (token: string) =>
      token === 'good-refresh'
        ? Promise.resolve(refreshClaims)
        : Promise.reject(new Error('invalid token')),
    decode: () => ({ exp: Math.floor(Date.now() / 1000) + 14_400 }),
  } as unknown as JwtService;

  // ITPO's Redis: the session and roles keys its services check.
  const store = new Map<string, { value: string; ttl?: number }>();
  const redis = {
    get: (key: string) => Promise.resolve(store.get(key)?.value ?? null),
    set: (key: string, value: string, ttl?: number) => {
      store.set(key, { value, ttl });
      return Promise.resolve();
    },
    del: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  } as unknown as RedisService;

  const settings: Record<string, string> = {
    'auth.refreshSecret': 'r'.repeat(32),
    'auth.refreshExpires': '7d',
  };
  const config = {
    getOrThrow: (key: string) => settings[key],
  } as unknown as ConfigService;
  return { service: new AuthService(db, jwt, redis, config), sql, signed, store };
}

const login = (s: AuthService, password = 'correct horse', email = 'asha@itpo.test') =>
  s.login(email, password, '10.0.0.1');

describe('AuthService.login', () => {
  it('signs in a user with no org_id as ITPO staff', async () => {
    const result = await login(build(row({ org_id: null })).service);

    expect(result.accessToken).toBe('token');
    expect(result.user.type).toBe(UserType.ItpoStaff);
    expect(result.user.orgId).toBeNull();
  });

  it('signs in a user with an org_id as an organiser of that organisation', async () => {
    const result = await login(build(row({ org_id: 'org-1' }), ['organizer']).service);

    expect(result.user.type).toBe(UserType.Organiser);
    expect(result.user.orgId).toBe('org-1');
    expect(result.user.roles).toEqual(['organizer']);
  });

  it("gives an organiser's organisation name, and none to ITPO staff", async () => {
    const organiser = await login(
      build(row({ org_id: 'org-1', organisation_name: 'Acme Expo' }), ['organizer']).service,
    );
    const staff = await login(build(row()).service);

    expect(organiser.user.organisationName).toBe('Acme Expo');
    expect(staff.user.organisationName).toBeNull();
  });

  it('signs the token with the claims ITPO apps read: id, role, sessionId, orgId', async () => {
    const { service, signed } = build(row({ org_id: 'org-1' }), ['organizer']);
    await login(service);

    expect(signed[0]).toEqual({
      id: 'u1',
      role: ['organizer'],
      sessionId: expect.any(String),
      orgId: 'org-1',
    });
  });

  it("writes to ITPO's tables only the last login and the user's token", async () => {
    const { service, sql } = build(row(), ['itpo_admin']);
    await login(service);

    const writes = sql.filter((q) => /^\s*(UPDATE|INSERT|DELETE)/.test(q.text));
    expect(writes).toHaveLength(2);
    expect(writes[0].text).toContain('"last_login_date"');
    expect(writes[1].text).toContain('"T_AUTH_TOKEN"');
  });

  it("records the session where ITPO's services look, so they accept the token too", async () => {
    const { service, signed, store, sql } = build(row(), ['itpo_admin']);
    await login(service);

    const { sessionId } = signed[0] as { sessionId: string };
    expect(store.get('session:u1')?.value).toBe(sessionId);
    expect(JSON.parse(store.get('roles:u1')?.value ?? '[]')).toEqual(['itpo_admin']);
    expect(store.get('roles:u1')?.ttl).toBeGreaterThan(14_000);

    const upsert = sql.find((q) => q.text.includes('INSERT INTO idp."T_AUTH_TOKEN"'))!;
    expect(upsert.text).toContain('ON CONFLICT (user_id)');
    expect(upsert.params.slice(0, 2)).toEqual(['u1', 'token']);
  });

  it('replaces the session an earlier sign-in opened', async () => {
    const { service, signed, store } = build(row());
    await login(service);
    await login(service);

    // The access tokens' claims carry `role`; the refresh tokens' do not.
    const [first, second] = signed.filter((p) => 'role' in (p as object)) as {
      sessionId: string;
    }[];
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(store.get('session:u1')?.value).toBe(second.sessionId);
  });

  it('never returns the password hash', async () => {
    const result = await login(build(row()).service);

    expect(JSON.stringify(result)).not.toContain('$2');
  });

  it('refuses a wrong password and writes nothing, in the database or in Redis', async () => {
    const { service, sql, store } = build(row());

    await expect(login(service, 'nope')).rejects.toThrow(UnauthorizedException);
    expect(sql.some((q) => /^\s*(UPDATE|INSERT)/.test(q.text))).toBe(false);
    expect(store.size).toBe(0);
  });

  it('refuses a switched-off account even with the right password', async () => {
    await expect(login(build(row({ isActive: false })).service)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an unknown email with the same message as a wrong password', async () => {
    await expect(login(build(null).service, 'x', 'who@itpo.test')).rejects.toThrow(
      'Invalid email or password.',
    );
    await expect(login(build(row()).service, 'nope')).rejects.toThrow('Invalid email or password.');
  });
});

describe('AuthService.logout', () => {
  beforeEach(() => revoked.clear());

  it('revokes the session, for a week as long as the refresh token lives', async () => {
    const { service, sql } = build(row());
    await service.logout('u1', 'session-1');

    const insert = sql.find((q) => q.text.includes('INSERT INTO idp."T_AUTH_REVOKED_SESSION"'));
    expect(insert?.params).toEqual(['session-1', 'u1', String(7 * 24 * 3600 * 1000)]);
    expect(await service.isSessionRevoked('session-1')).toBe(true);
    expect(await service.isSessionRevoked('another')).toBe(false);
  });

  it("then refuses that session's refresh token", async () => {
    const { service } = build(row());
    refreshClaims = { id: 'u1', sessionId: 'session-1', hash: 'h' };
    await service.logout('u1', 'session-1');

    await expect(service.refresh('good-refresh')).rejects.toThrow(UnauthorizedException);
  });

  it("clears what ITPO's services look at: the session and roles in Redis, and the stored token", async () => {
    const { service, sql, store } = build(row());
    await login(service);
    expect(store.size).toBe(2);

    await service.logout('u1', 'session-1');

    expect(store.size).toBe(0);
    expect(
      sql.some((q) => q.text.includes('DELETE FROM idp."T_AUTH_TOKEN"') && q.params[0] === 'u1'),
    ).toBe(true);
  });
});

describe('AuthService.refresh', () => {
  beforeEach(() => revoked.clear());

  it('returns a new access token for the same session', async () => {
    const { service, signed } = build(row());
    const first = await login(service);
    const { sessionId } = signed[0] as { sessionId: string };
    refreshClaims = { id: 'u1', sessionId, hash: 'h' };

    const next = await service.refresh('good-refresh');

    expect(first.refreshToken).toBe('refresh-token');
    expect(next.accessToken).toBe('token');
    expect((signed[2] as { sessionId: string }).sessionId).toBe(sessionId);
  });

  it('refuses a token that does not verify', async () => {
    await expect(build(row()).service.refresh('forged')).rejects.toThrow(UnauthorizedException);
  });

  it("refuses a session that ITPO's Redis no longer holds, or another sign-in replaced", async () => {
    const { service, signed, store } = build(row());
    await login(service);
    const { sessionId } = signed[0] as { sessionId: string };
    refreshClaims = { id: 'u1', sessionId, hash: 'h' };

    store.set('session:u1', { value: 'opened-in-an-itpo-app' });
    await expect(service.refresh('good-refresh')).rejects.toThrow(UnauthorizedException);

    store.delete('session:u1');
    await expect(service.refresh('good-refresh')).rejects.toThrow(UnauthorizedException);
  });

  it("keeps the new token in step with ITPO's table and the roles in Redis", async () => {
    const { service, signed, sql, store } = build(row(), ['itpo_admin']);
    await login(service);
    const { sessionId } = signed[0] as { sessionId: string };
    refreshClaims = { id: 'u1', sessionId, hash: 'h' };
    sql.length = 0;
    store.delete('roles:u1');

    await service.refresh('good-refresh');

    expect(sql.some((q) => q.text.includes('INSERT INTO idp."T_AUTH_TOKEN"'))).toBe(true);
    expect(store.get('roles:u1')).toBeDefined();
  });

  it('refuses a switched-off account', async () => {
    refreshClaims = { id: 'u1', sessionId: 's', hash: 'h' };

    await expect(build(null).service.refresh('good-refresh')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
