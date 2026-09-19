import { Controller, Get } from '@nestjs/common';

import type { LayoutSummaryResponse } from './dto/layout-response.dto';
import { LayoutService } from './layout.service';

/** GET /api/layouts — port of LayoutsController.java. The list both frontends call. */
@Controller('layouts')
export class LayoutsController {
  constructor(private readonly layoutService: LayoutService) {}

  @Get()
  list(): Promise<LayoutSummaryResponse[]> {
    return this.layoutService.list();
  }
}
