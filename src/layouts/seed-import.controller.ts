import { Body, Controller, Headers, NotFoundException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { LayoutDetailResponse } from './dto/layout-response.dto';
import { LayoutSaveRequestDto } from './dto/layout-save-request.dto';
import { LayoutService } from './layout.service';

/**
 * POST /api/layout/seed-import — one-time import of EXISTING production layouts.
 *
 * Legacy venue plans were placed by hand and intentionally sit back-to-back, so they
 * fail the save-time placement rules (BR-24) that guard interactive edits. The service
 * already supports trusted imports via `skipPlacementRules`; this endpoint is the only
 * HTTP surface for it and stays hidden (404) unless the caller presents the SEED_TOKEN
 * runtime secret. Everything else — DTO validation, hall-geometry checks, stall
 * numbering — runs exactly as for a normal save.
 */
@Controller('layout')
export class SeedImportController {
  constructor(
    private readonly layoutService: LayoutService,
    private readonly config: ConfigService,
  ) {}

  @Post('seed-import')
  seedImport(
    @Body() request: LayoutSaveRequestDto,
    @Headers('x-seed-token') token?: string,
  ): Promise<LayoutDetailResponse> {
    const expected = this.config.get<string>('SEED_TOKEN');
    if (!expected || token !== expected) throw new NotFoundException();

    return this.layoutService.save(request, { skipPlacementRules: true });
  }
}
