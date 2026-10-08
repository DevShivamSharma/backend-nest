import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentAccess, OrgAccess, RequirePermissions } from '../access/org-access.decorators';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser, OrgAccessContext } from '../common/http/authenticated-request';
import {
  CreateHallDto,
  DeleteHallsDto,
  CreateVenueDto,
  ItpoFileDto,
  ItpoImportDto,
  UpdateHallDto,
  UpdateVenueDto,
} from './dto/venue.dto';
import type { HallFloor } from './floor/hall-floor';
import { HallsService } from './halls.service';
import { ItpoHallImportService } from './itpo-hall-import.service';
import type {
  HallDetailView,
  HallView,
  ItpoImportPreview,
  ItpoImportResult,
  VenueView,
} from './venue.views';
import { VenuesService } from './venues.service';

/** Venues and their halls (Module B). Seeing needs `venues.view`; each change says its own. */
@OrgAccess('venues.view')
@Controller('orgs/:slug')
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly halls: HallsService,
    private readonly itpo: ItpoHallImportService,
  ) {}

  @Get('venues')
  list(@CurrentAccess() access: OrgAccessContext): Promise<VenueView[]> {
    return this.venues.list(access.organisation.id);
  }

  @RequirePermissions('venues.manage')
  @Post('venues')
  create(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateVenueDto,
  ): Promise<VenueView> {
    return this.venues.create(access.organisation, dto, user);
  }

  @Get('venues/:venueId')
  get(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ): Promise<VenueView> {
    return this.venues.get(access.organisation.id, venueId);
  }

  @RequirePermissions('venues.manage')
  @Patch('venues/:venueId')
  update(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body() dto: UpdateVenueDto,
  ): Promise<VenueView> {
    return this.venues.update(access.organisation.id, venueId, dto, user);
  }

  @RequirePermissions('venues.manage')
  @Delete('venues/:venueId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ): Promise<void> {
    return this.venues.remove(access.organisation.id, venueId, user);
  }

  @Get('venues/:venueId/halls')
  hallsOf(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ): Promise<HallView[]> {
    return this.halls.listForVenue(access.organisation.id, venueId);
  }

  @RequirePermissions('venues.manage')
  @Post('venues/:venueId/halls')
  createHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body() dto: CreateHallDto,
  ): Promise<HallView> {
    return this.halls.create(access.organisation.id, venueId, dto, user);
  }

  /** Deletes several halls of the venue at once; all or none. */
  @RequirePermissions('venues.manage')
  @Post('venues/:venueId/halls/delete')
  @HttpCode(HttpStatus.OK)
  removeHalls(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body() dto: DeleteHallsDto,
  ): Promise<{ deleted: number }> {
    return this.halls.removeMany(access.organisation.id, venueId, dto.hallIds, user);
  }

  /** What importing an ITPO export would do. Saves nothing. */
  @RequirePermissions('halls.import')
  @Post('venues/:venueId/halls/import/itpo/preview')
  @HttpCode(HttpStatus.OK)
  previewItpo(
    @CurrentAccess() access: OrgAccessContext,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body() dto: ItpoFileDto,
  ): Promise<ItpoImportPreview> {
    return this.itpo.preview(access.organisation.id, venueId, dto);
  }

  @RequirePermissions('halls.import')
  @Post('venues/:venueId/halls/import/itpo')
  importItpo(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Body() dto: ItpoImportDto,
  ): Promise<ItpoImportResult> {
    return this.itpo.import(access.organisation.id, venueId, dto, user);
  }

  @Get('halls/:hallId')
  hall(
    @CurrentAccess() access: OrgAccessContext,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<HallDetailView> {
    return this.halls.get(access.organisation.id, hallId);
  }

  @RequirePermissions('venues.manage')
  @Patch('halls/:hallId')
  updateHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Body() dto: UpdateHallDto,
  ): Promise<HallView> {
    return this.halls.update(access.organisation.id, hallId, dto, user);
  }

  @RequirePermissions('venues.manage')
  @Delete('halls/:hallId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeHall(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('hallId', ParseUUIDPipe) hallId: string,
  ): Promise<void> {
    return this.halls.remove(access.organisation.id, hallId, user);
  }

  @Get('halls/:hallId/versions/:version')
  floorVersion(
    @CurrentAccess() access: OrgAccessContext,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<{ version: number; floor: HallFloor }> {
    return this.halls.floorVersion(access.organisation.id, hallId, version);
  }

  @RequirePermissions('venues.manage')
  @Post('halls/:hallId/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentAccess() access: OrgAccessContext,
    @CurrentUser() user: AuthUser,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<HallDetailView> {
    return this.halls.restore(access.organisation.id, hallId, version, user);
  }
}
