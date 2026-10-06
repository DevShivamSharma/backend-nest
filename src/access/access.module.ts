import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganisationsModule } from '../organisations/organisations.module';
import { RolesModule } from '../roles/roles.module';
import { MembershipEntity } from './membership.entity';
import { MembershipsService } from './memberships.service';
import { OrgAccessGuard } from './org-access.guard';
import { OrgContextController } from './org-context.controller';

/**
 * Who may do what inside an organisation. Modules with `/orgs/:slug/...` routes import this
 * one; it re-exports what `OrgAccessGuard` needs, so the guard resolves in their injector.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MembershipEntity]), OrganisationsModule, RolesModule],
  controllers: [OrgContextController],
  providers: [MembershipsService, OrgAccessGuard],
  exports: [MembershipsService, OrgAccessGuard, OrganisationsModule, RolesModule],
})
export class AccessModule {}
