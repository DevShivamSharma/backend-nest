import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/http/authenticated-request';

/** Platform administration is for the Super Admin only. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user?.isPlatformAdmin) {
      throw new ForbiddenException('Only the platform administrator can do this.');
    }
    return true;
  }
}

export const PlatformAdminOnly = () => applyDecorators(UseGuards(PlatformAdminGuard));
