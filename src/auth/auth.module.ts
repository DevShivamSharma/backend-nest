import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import type { AuthConfig } from '../config/configuration';
import { MailModule } from '../mail/mail.module';
import { TeamModule } from '../team/team.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordResetTokenEntity } from './password-reset-token.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { JWT_AUDIENCE, JWT_ISSUER, TokensService } from './tokens.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshTokenEntity, PasswordResetTokenEntity]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.getOrThrow<AuthConfig>('auth');
        return {
          secret: auth.accessSecret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: auth.accessTtlSeconds,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
        };
      },
    }),
    UsersModule,
    AccessModule,
    TeamModule,
    MailModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    // Every route is signed-in only unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
