import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { AuthenticatedRequest } from '../../common/http/authenticated-request';
import { UsersService } from '../../users/users.service';
import { TokensService } from '../tokens.service';

/**
 * Global guard: every route needs a valid access token unless marked `@Public()`. The user is
 * loaded on each request, so disabling an account takes effect at once.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    const payload = scheme === 'Bearer' && token ? await this.tokens.verifyAccess(token) : null;
    const user = payload ? await this.users.findActiveById(payload.sub) : null;
    if (!user) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    request.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
    };
    return true;
  }
}
