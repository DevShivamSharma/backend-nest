import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthUser, clientInfo } from '../common/http/authenticated-request';
import type { AuthConfig } from '../config/configuration';
import { InvitationsService } from '../team/invitations.service';
import type { InvitationPreview } from '../team/team.views';
import type { AcceptedInvitationView, DevLoginView, MeView, SessionView } from './auth.views';
import { AuthService } from './auth.service';
import {
  AcceptInvitationDto,
  DevLoginDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import type { IssuedRefresh } from './tokens.service';

/** The refresh token lives only in this httpOnly cookie, scoped to the auth routes. */
export const REFRESH_COOKIE = 'rt';
const REFRESH_COOKIE_PATH = '/api/auth';

/** Tight limits on everything that guesses at a secret or sends an email. */
const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  private readonly cookieSecure: boolean;
  private readonly devLoginEmails: string[];

  constructor(
    private readonly auth: AuthService,
    private readonly invitations: InvitationsService,
    config: ConfigService,
  ) {
    const authConfig = config.getOrThrow<AuthConfig>('auth');
    this.cookieSecure = authConfig.cookieSecure;
    this.devLoginEmails = authConfig.devLoginEmails;
  }

  @Public()
  @Throttle(SENSITIVE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    const { session, refresh } = await this.auth.login(dto.email, dto.password, clientInfo(req));
    this.setRefreshCookie(res, refresh);
    return session;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    const token = this.readRefreshCookie(req);
    if (!token) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    try {
      const { session, refresh } = await this.auth.refresh(token, clientInfo(req));
      this.setRefreshCookie(res, refresh);
      return session;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.clearRefreshCookie(res);
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = this.readRefreshCookie(req);
    if (token) {
      await this.auth.logout(token);
    }
    this.clearRefreshCookie(res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<MeView> {
    return this.auth.me(user);
  }

  /**
   * Local development only: the accounts the quick-login page offers. Not found in production
   * or when DEV_LOGIN_EMAILS is empty, so the route reveals nothing there.
   */
  @Public()
  @Get('dev-logins')
  devLogins(): Promise<DevLoginView[]> {
    this.assertDevLogin();
    return this.auth.devLogins(this.devLoginEmails);
  }

  /** Local development only: signs in as one of those accounts, without its password. */
  @Public()
  @Throttle(SENSITIVE)
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  async devLogin(
    @Body() dto: DevLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    this.assertDevLogin();
    const { session, refresh } = await this.auth.devLogin(
      dto.email,
      this.devLoginEmails,
      clientInfo(req),
    );
    this.setRefreshCookie(res, refresh);
    return session;
  }

  private assertDevLogin(): void {
    if (!this.devLoginEmails.length) throw new NotFoundException();
  }

  @Public()
  @Throttle(SENSITIVE)
  @Get('invitations/:token')
  invitation(@Param('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Public()
  @Throttle(SENSITIVE)
  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcceptedInvitationView> {
    const { session, refresh } = await this.auth.acceptInvitation(token, dto, clientInfo(req));
    this.setRefreshCookie(res, refresh);
    return session;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.auth.forgotPassword(dto.email, dto.orgSlug);
  }

  @Public()
  @Throttle(SENSITIVE)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.password, clientInfo(req));
  }

  private readRefreshCookie(req: Request): string | null {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private setRefreshCookie(res: Response, refresh: IssuedRefresh): void {
    res.cookie(REFRESH_COOKIE, refresh.token, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: refresh.expiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
