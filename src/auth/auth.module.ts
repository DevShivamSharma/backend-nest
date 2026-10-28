import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';

import type { AllConfigType } from '../config/config.type';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UserTypesGuard } from './guards/user-types.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        secret: configService.getOrThrow('auth.secret', { infer: true }),
        signOptions: {
          expiresIn: configService.getOrThrow('auth.expires', {
            infer: true,
          }) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  // Order matters: sign-in first, then the check on who is signed in.
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserTypesGuard },
  ],
})
export class AuthModule {}
