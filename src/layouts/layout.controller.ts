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
} from '@nestjs/common';

import type {
  LayoutAuditResponse,
  LayoutDeletedResponse,
  LayoutDetailResponse,
  LayoutSummaryResponse,
} from './dto/layout-response.dto';
import { LayoutSaveRequestDto, SplitStallDto } from './dto/layout-save-request.dto';
import { LayoutService } from './layout.service';

/**
 * /api/layout/** — port of LayoutController.java. Thin: no logic here.
 *
 * A non-numeric {id} is rejected by ParseIntPipe with 400. The Java answered 500 for that
 * (inferred); the change is deliberate (ADR-014).
 */
@Controller('layout')
export class LayoutController {
  constructor(private readonly layoutService: LayoutService) {}

  /** 201 CREATED — Nest's default for POST, same as the Java. */
  @Post('save')
  save(@Body() request: LayoutSaveRequestDto): Promise<LayoutDetailResponse> {
    return this.layoutService.save(request);
  }

  /**
   * @deprecated Duplicate of GET /api/layouts; neither frontend calls it (ADR-002).
   * Declared before ':id' so "list" is not captured as an id.
   */
  @Get('list')
  list(): Promise<LayoutSummaryResponse[]> {
    return this.layoutService.list();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<LayoutDetailResponse> {
    return this.layoutService.get(id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() request: LayoutSaveRequestDto,
  ): Promise<LayoutDetailResponse> {
    return this.layoutService.update(id, request);
  }

  @Post(':id/stalls/:stallNumber/split')
  @HttpCode(200)
  split(
    @Param('id', ParseIntPipe) id: number,
    @Param('stallNumber') number: string,
    @Body() request: SplitStallDto,
  ): Promise<LayoutDetailResponse> {
    return this.layoutService.split(id, number, request);
  }

  /** Rule audit of the saved layout (reporting only, never blocks). 200: nothing is created. */
  @Post(':id/validate')
  @HttpCode(200)
  validate(@Param('id', ParseIntPipe) id: number): Promise<LayoutAuditResponse> {
    return this.layoutService.audit(id);
  }

  /** 200 with a body, not 204 — as in the Java (LayoutController.java:68-80). */
  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<LayoutDeletedResponse> {
    await this.layoutService.delete(id);

    return { message: 'Layout deleted successfully.', id };
  }
}
