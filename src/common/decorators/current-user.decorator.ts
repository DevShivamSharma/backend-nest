import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { SessionUser } from '../../auth/domain/session-user';

/** The signed-in user, put on the request by the sign-in guard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request & { user: SessionUser }>();
  return request.user;
});
