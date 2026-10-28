import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserType } from '../domain/user-type';
import { UserTypesGuard } from './user-types.guard';

function context(user: unknown, allowed?: UserType[]) {
  const reflector = { getAllAndOverride: () => allowed } as unknown as Reflector;
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
  return { guard: new UserTypesGuard(reflector), ctx };
}

describe('UserTypesGuard', () => {
  it('lets anyone through a route with no restriction', () => {
    const { guard, ctx } = context({ type: UserType.Organiser });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets the allowed kind through', () => {
    const { guard, ctx } = context({ type: UserType.ItpoStaff }, [UserType.ItpoStaff]);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('refuses another kind of user', () => {
    const { guard, ctx } = context({ type: UserType.Organiser }, [UserType.ItpoStaff]);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
