import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrgAccess, CurrentAccess } from '../../access/org-access.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../../common/http/authenticated-request';
import { FloorPlanService } from './floor-plan.service';
@OrgAccess('venues.view', 'halls.import')
@Controller('orgs/:slug/venues/:venueId/floor-plans')
export class FloorPlanController {
  constructor(private service: FloorPlanService) {}
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  upload(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venue: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Query('fresh') fresh?: string,
  ) {
    return this.service.upload(access.organisation.id, venue, file, fresh === 'true');
  }
  @Get(':id') view(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venue: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.view(access.organisation.id, venue, id);
  }
  @Patch(':id') edit(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venue: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.edit(access.organisation.id, venue, id, body);
  }
  @Get(':id/preview') preview(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venue: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('key') key: string,
    @Query('target') target?: string,
  ) {
    return this.service.preview(access.organisation.id, venue, id, key, target);
  }
  @Post(':id/commit') commit(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venue: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.commit(access.organisation.id, venue, id, body, user);
  }
}
