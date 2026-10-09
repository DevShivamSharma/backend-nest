import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { CategoriesService } from './categories.service';
import type { CategoryImportView, CategoryView } from './categories.views';
import { CreateCategoryDto, ImportCategoriesDto, UpdateCategoryDto } from './dto/categories.dto';

/**
 * Stall categories (Module E). The venue's team sees them, to put them on event halls;
 * changes need `categories.manage`, which only the Venue Admin holds unless given to others.
 */
@OrgAccess('events.view')
@Controller('orgs/:slug/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentAccess() access: OrgAccessContext): Promise<CategoryView[]> {
    return this.categories.list(access.organisation.id);
  }

  @RequirePermissions('categories.manage')
  @Post()
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.create(access.organisation.id, dto, user);
  }

  @RequirePermissions('categories.manage')
  @Post('import')
  @HttpCode(HttpStatus.OK)
  import(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportCategoriesDto,
  ): Promise<CategoryImportView> {
    return this.categories.import(access.organisation.id, dto, user);
  }

  @RequirePermissions('categories.manage')
  @Patch(':id')
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return this.categories.update(access.organisation.id, id, dto, user);
  }

  @RequirePermissions('categories.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.categories.remove(access.organisation.id, id, user);
  }
}
