import { ALL_PERMISSIONS } from './permissions';
import { RoleEntity, RoleScopeKind } from './role.entity';
import { RolesService } from './roles.service';

function role(overrides: Partial<RoleEntity>): RoleEntity {
  return Object.assign(new RoleEntity(), {
    id: 'r1',
    organisationId: null,
    key: 'custom',
    name: 'Custom',
    description: null,
    scopeKind: RoleScopeKind.Organisation,
    permissions: [],
    isSystem: false,
    isLocked: false,
    ...overrides,
  });
}

describe('RolesService rules', () => {
  it('gives a locked role every permission, whatever is stored', () => {
    expect(RolesService.effectivePermissions(role({ isLocked: true, permissions: [] }))).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it('drops permissions that left the catalogue', () => {
    expect(
      RolesService.effectivePermissions(role({ permissions: ['team.view', 'retired.permission'] })),
    ).toEqual(['team.view']);
  });

  it('lets a member grant a role within their own permissions', () => {
    const granted = role({ permissions: ['team.view'] });
    expect(RolesService.grantCheck(['team.view', 'team.invite'], granted)).toBeNull();
  });

  it('refuses a role with a permission the granter lacks', () => {
    const granted = role({ permissions: ['team.view', 'team.manage'] });
    expect(RolesService.grantCheck(['team.view', 'team.invite'], granted)).toMatch(/do not have/);
  });

  it('refuses the locked owner role to anyone without every permission', () => {
    const ownerRole = role({ isLocked: true });
    expect(RolesService.grantCheck(ALL_PERMISSIONS.slice(1), ownerRole)).not.toBeNull();
    expect(RolesService.grantCheck(ALL_PERMISSIONS, ownerRole)).toBeNull();
  });

  it('refuses event roles until events exist', () => {
    const exhibitor = role({ scopeKind: RoleScopeKind.Event, permissions: ['stalls.book'] });
    expect(RolesService.grantCheck(ALL_PERMISSIONS, exhibitor)).toMatch(/event/i);
  });
});
