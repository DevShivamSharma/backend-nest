import { ALL_PERMISSIONS, holdsAll, isPermission, normalisePermissions } from './permissions';

describe('permission catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('recognises catalogue keys only', () => {
    expect(isPermission('team.invite')).toBe(true);
    expect(isPermission('team.everything')).toBe(false);
  });

  it('normalises to catalogue order without duplicates or unknown keys', () => {
    expect(normalisePermissions(['team.manage', 'nope', 'team.view', 'team.view'])).toEqual([
      'team.view',
      'team.manage',
    ]);
  });

  it('checks that every wanted permission is held', () => {
    expect(holdsAll(['team.view', 'team.invite'], ['team.view'])).toBe(true);
    expect(holdsAll(['team.view'], ['team.view', 'team.invite'])).toBe(false);
    expect(holdsAll([], [])).toBe(true);
  });
});
