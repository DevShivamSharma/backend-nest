import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import { PayoutDto } from './dto/settlement.dto';
import type { SettlementView } from './settlement.views';
import { SettlementsService } from './settlements.service';

/** An event's settlement (docs/15 §6.3). Organisers read their own events'; staff close and pay out. */
@OrgAccess('reports.view')
@AllowEventRoles()
@Controller('orgs/:slug/events/:id/settlement')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SettlementView> {
    return this.settlements.get(access, id);
  }

  @RequirePermissions('payments.manage', 'reports.view')
  @Post('close')
  @HttpCode(HttpStatus.OK)
  close(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SettlementView> {
    return this.settlements.close(access, id, user);
  }

  @RequirePermissions('payments.manage', 'reports.view')
  @Post('payout')
  @HttpCode(HttpStatus.OK)
  payout(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayoutDto,
  ): Promise<SettlementView> {
    return this.settlements.payout(access, id, dto, user);
  }
}
