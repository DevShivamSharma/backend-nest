import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { CheckLayoutDto, UpdateRulesDto } from './dto/rules.dto';
import { RuleCheckView, RulesService, RulesView } from './rules.service';

/** Rules (Module C). Seeing needs `rules.view`; changes need `rules.manage`. */
@OrgAccess('rules.view')
@Controller('orgs/:slug/rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  /** The rules that can be checked, the limits on their values, and the drawing profiles. */
  @AllowEventRoles()
  @Get('catalogue')
  catalogue(): ReturnType<RulesService['catalogue']> {
    return this.rules.catalogue();
  }

  /** The organisation's rules: which are on, their values, documents and drawing profile. */
  @Get()
  get(@CurrentAccess() access: OrgAccessContext): Promise<RulesView> {
    return this.rules.get(access.organisation.id);
  }

  @RequirePermissions('rules.manage')
  @Patch()
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateRulesDto,
  ): Promise<RulesView> {
    return this.rules.update(access.organisation.id, dto, user);
  }

  /** Checks stalls on a hall against the organisation's rules. Saves nothing. */
  @RequirePermissions('rules.view', 'venues.view')
  @Post('check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentAccess() access: OrgAccessContext,
    @Body() dto: CheckLayoutDto,
  ): Promise<RuleCheckView> {
    return this.rules.check(access.organisation.id, dto);
  }
}
