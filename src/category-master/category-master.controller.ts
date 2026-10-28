import { Controller, Delete, HttpCode, Param, ParseIntPipe } from '@nestjs/common';

import { AllowedUserTypes } from '../auth/decorators/user-types.decorator';
import type { SessionUser } from '../auth/domain/session-user';
import { UserType } from '../auth/domain/user-type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CategoryMasterService } from './category-master.service';

/** Deleting a category or a group of categories for good (ITPO staff). */
@AllowedUserTypes(UserType.ItpoStaff)
@Controller({ path: 'category-master', version: '1' })
export class CategoryMasterController {
  constructor(private readonly master: CategoryMasterService) {}

  @Delete('categories/:id')
  @HttpCode(200)
  async deleteCategory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: SessionUser,
  ): Promise<null> {
    await this.master.deleteCategory(id, user);
    return null;
  }

  @Delete('groups/:id')
  @HttpCode(200)
  async deleteGroup(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: SessionUser,
  ): Promise<null> {
    await this.master.deleteGroup(id, user);
    return null;
  }
}
