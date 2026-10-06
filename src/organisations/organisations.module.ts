import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { OrganisationConfigVersionEntity } from './organisation-config-version.entity';
import { OrganisationSlugAliasEntity } from './organisation-slug-alias.entity';
import { OrganisationEntity } from './organisation.entity';
import { OrganisationsService } from './organisations.service';
import { PublicConfigController } from './public-config.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrganisationEntity,
      OrganisationSlugAliasEntity,
      OrganisationConfigVersionEntity,
    ]),
    AuditModule,
  ],
  controllers: [PublicConfigController],
  providers: [OrganisationsService],
  exports: [OrganisationsService],
})
export class OrganisationsModule {}
