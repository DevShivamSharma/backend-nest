import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { InvitationEntity } from './invitation.entity';
import { InvitationsService } from './invitations.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvitationEntity]),
    AccessModule,
    UsersModule,
    MailModule,
    AuditModule,
  ],
  controllers: [TeamController],
  providers: [InvitationsService, TeamService],
  exports: [InvitationsService, TeamService],
})
export class TeamModule {}
