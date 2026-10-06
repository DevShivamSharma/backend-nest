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
  Query,
} from '@nestjs/common';

import { PlatformAdminOnly } from '../auth/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/http/authenticated-request';
import { CreateRoleDto, RoleListQueryDto, UpdateRoleDto } from '../roles/dto/role.dto';
import { PERMISSION_GROUPS, PermissionGroup } from '../roles/permissions';
import type { AdminRoleView } from '../roles/role.views';
import { RolesService } from '../roles/roles.service';

/** Dynamic RBAC: the Super Admin defines roles from the permission catalogue. */
@PlatformAdminOnly()
@Controller('admin')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  permissions(): readonly PermissionGroup[] {
    return PERMISSION_GROUPS;
  }

  @Get('roles')
  list(@Query() query: RoleListQueryDto): Promise<AdminRoleView[]> {
    return this.roles.listForAdmin(query.organisationId);
  }

  @Get('roles/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminRoleView> {
    return this.roles.getForAdmin(id);
  }

  @Post('roles')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto): Promise<AdminRoleView> {
    return this.roles.create(dto, user);
  }

  @Patch('roles/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<AdminRoleView> {
    return this.roles.update(id, dto, user);
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.roles.remove(id, user);
  }
}
