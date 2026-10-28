import { Module } from '@nestjs/common';

import { CategoryMasterController } from './category-master.controller';
import { CategoryMasterService } from './category-master.service';

@Module({ controllers: [CategoryMasterController], providers: [CategoryMasterService] })
export class CategoryMasterModule {}
