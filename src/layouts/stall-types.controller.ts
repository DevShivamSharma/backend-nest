import { Controller, Get } from '@nestjs/common';

import { STALL_TYPES, StallType } from './stall-types';

/** GET /api/stall-types: the stall sizes the editor offers. Configuration, not rendering logic. */
@Controller('stall-types')
export class StallTypesController {
  @Get()
  list(): readonly StallType[] {
    return STALL_TYPES;
  }
}
