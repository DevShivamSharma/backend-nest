import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { RequestSession } from '../../auth/domain/session-user';

/** The session of the signed-in request, put on it by the sign-in guard. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request & { session: RequestSession }>();
  return request.session;
});
