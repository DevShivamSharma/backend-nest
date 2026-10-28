import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { RESPONSE_MESSAGES } from '../../common/constants/response-messages.constant';
import { CustomMessage } from '../../common/decorators/custom-message.decorator';
import { CurrentSession } from '../../common/decorators/current-session.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService, LoginResult, TokenResult } from '../services/auth.service';
import { LoginDto } from '../dto/login.dto';
import type { RequestSession, SessionUser } from '../domain/session-user';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Tighter than the app-wide limit: sign-in is the one route worth guessing passwords at. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password, ip || null);
  }

  /** The refresh token goes as a bearer token, as in ITPO's own apps. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Headers('authorization') authorization = ''): Promise<TokenResult> {
    const [scheme, token] = authorization.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    return this.auth.refresh(token);
  }

  /** Ends this session: the access token used here and its refresh token stop working. */
  @HttpCode(200)
  @CustomMessage(RESPONSE_MESSAGES.USER_LOGOUT_MSG)
  @Post('logout')
  async logout(
    @CurrentUser() user: SessionUser,
    @CurrentSession() session: RequestSession,
  ): Promise<void> {
    await this.auth.logout(user.id, session.id);
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user;
  }
}
