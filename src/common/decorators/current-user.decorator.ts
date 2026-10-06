import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { AuthenticatedRequest, AuthUser } from '../http/authenticated-request';

/** The signed-in user. Only valid on routes behind the access-token guard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) {
    throw new UnauthorizedException('Sign in to continue.');
  }
  return user;
});
