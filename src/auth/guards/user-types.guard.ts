import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { SessionUser } from '../domain/session-user';
import { ALLOWED_USER_TYPES_KEY } from '../decorators/user-types.decorator';
import type { UserType } from '../domain/user-type';

/** Runs after the sign-in guard: refuses a signed-in user of the wrong kind. */
@Injectable()
export class UserTypesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserType[] | undefined>(
      ALLOWED_USER_TYPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    if (!user || !allowed.includes(user.type)) {
      throw new ForbiddenException('You do not have access to this.');
    }
    return true;
  }
}
