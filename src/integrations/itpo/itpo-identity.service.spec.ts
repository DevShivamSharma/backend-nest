import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import type { DataSource } from 'typeorm';

import type { MembershipsService } from '../../access/memberships.service';
import type { OrganisationsService } from '../../organisations/organisations.service';
import { UserEntity } from '../../users/user.entity';
import { ItpoIdentityService } from './itpo-identity.service';

describe('ItpoIdentityService', () => {
  const hash = bcrypt.hashSync('right-password-1', 4);
  // ITPO keeps PHP-style hashes too.
  const phpHash = `$2y$${hash.slice(4)}`;

  function service(row: Record<string, unknown> | null) {
    const query = jest.fn(async (sql: string) =>
      sql.includes('FROM idp."T_USER"') ? (row ? [row] : []) : [],
    );
    const mirrored = Object.assign(new UserEntity(), { id: 'ours', email: 'a@itpo.test' });
    const dataSource = {
      query,
      transaction: jest.fn(async () => mirrored),
      // No ITPO organisation yet: branding has nothing to do.
      getRepository: () => ({ findOneBy: async () => null }),
    } as unknown as DataSource;
    const config = {
      getOrThrow: () => ({
        authSource: 'itpo',
        orgSlug: 'itpo',
        orgName: 'ITPO',
        adminRoles: ['system_admin', 'stall_admin'],
      }),
    } as unknown as ConfigService;
    const svc = new ItpoIdentityService(
      dataSource,
      {} as OrganisationsService,
      {} as MembershipsService,
      config,
    );
    return { svc, query, dataSource };
  }

  const user = (more: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'A@itpo.test',
    password: hash,
    isActive: true,
    orgId: null,
    name: 'A',
    roles: ['system_admin'],
    ...more,
  });

  it('tells admins from organisers by their ITPO roles', () => {
    const { svc } = service(null);
    expect(svc.kindOf({ roles: ['organizer'] })).toBe('organiser');
    expect(svc.kindOf({ roles: ['stall_admin'] })).toBe('admin');
    expect(svc.kindOf({ roles: ['finance_officer'] })).toBeNull();
    expect(svc.kindOf({ roles: [] })).toBeNull();
  });

  it('signs in an admin with a bcrypt password, PHP-style hashes too, and notes the sign-in in ITPO', async () => {
    for (const password of [hash, phpHash]) {
      const { svc, query, dataSource } = service(user({ password }));
      await expect(
        svc.signIn('a@itpo.test', 'right-password-1', '10.0.0.1'),
      ).resolves.toMatchObject({ id: 'ours' });
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(expect.stringContaining('last_login_date'), [
        '10.0.0.1',
        'u1',
      ]);
    }
  });

  it('refuses a wrong password and an unknown email alike', async () => {
    await expect(service(user()).svc.signIn('a@itpo.test', 'wrong', null)).rejects.toThrow(
      'Email or password is incorrect.',
    );
    await expect(service(null).svc.signIn('x@itpo.test', 'wrong', null)).rejects.toThrow(
      'Email or password is incorrect.',
    );
  });

  it('refuses a blocked account, a role without access, and an organiser with no organisation', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ isActive: false }, 'blocked'],
      [{ roles: ['finance_officer'] }, 'no access to stall planning'],
      [{ roles: ['organizer'], orgId: null }, 'not linked to an organisation'],
    ];
    for (const [more, message] of cases) {
      const { svc, dataSource } = service(user(more));
      const signIn = svc.signIn('a@itpo.test', 'right-password-1', null);
      await expect(signIn).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(signIn).rejects.toThrow(message);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    }
  });

  it('signs in an organiser of an organisation, and notes it on the organisation', async () => {
    const { svc, query } = service(user({ roles: ['organizer'], orgId: 'org-1' }));
    await svc.signIn('a@itpo.test', 'right-password-1', null);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('T_ORGANIZATION'), ['org-1']);
  });
});
