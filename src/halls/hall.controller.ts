import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { HallDto } from '../layouts/dto/layout-save-request.dto';
import type { HallResponse } from '../layouts/dto/layout-response.dto';
import { HallService } from './hall.service';

/**
 * /api/halls/** — port of HallController.java. Thin: no logic here.
 *
 * @deprecated No known consumer (ADR-002). Status codes match the Java exactly: 201 on create,
 * 204 on delete, 200 elsewhere, and 400 for "not found" (ADR-003).
 *
 * A non-numeric {id} is rejected by ParseIntPipe with 400, as on the layout path (ADR-014).
 */
@Controller('halls')
export class HallController {
  constructor(private readonly hallService: HallService) {}

  /**
   * `?standalone=true` returns only halls that no layout owns — what the planner's hall picker
   * asks for. Without the parameter this is the Java's unfiltered `findAll()`.
   */
  @Get()
  list(@Query('standalone') standalone?: string): Promise<HallResponse[]> {
    return this.hallService.list(standalone === 'true');
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<HallResponse> {
    return this.hallService.get(id);
  }

  /** 201 CREATED — Nest's default for POST, same as the Java. */
  @Post()
  create(@Body() request: HallDto): Promise<HallResponse> {
    return this.hallService.create(request);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() request: HallDto,
  ): Promise<HallResponse> {
    return this.hallService.update(id, request);
  }

  /** 204 NO CONTENT with an empty body — as in the Java (HallController.java:96-109). */
  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.hallService.delete(id);
  }
}
