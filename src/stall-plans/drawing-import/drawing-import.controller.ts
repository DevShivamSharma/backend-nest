import {
  BadRequestException,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import type { SessionUser } from '../../auth/domain/session-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { StallPlansService } from '../services/stall-plans.service';
import { isAsciiDxf } from './dxf-reader';
import { DrawingImportService } from './drawing-import.service';
import type { HallStalls } from './hall-match';
import type { AiCheck } from './drawing-check';
import { DrawingCheckService } from './drawing-check.service';

export const MAX_DRAWING_BYTES = 25 * 1024 * 1024;
/** Each read is seconds of CPU. */
const READ_LIMIT = { default: { limit: 6, ttl: 60_000 } };

type Upload = { buffer?: Buffer; size?: number } | undefined;

/**
 * A CAD plan (PDF exported from AutoCAD, or a DXF) read for a hall's stall plan: a PDF is first
 * converted to DXF, and the stalls are read from that. It answers with the stalls it draws of THIS
 * hall (a plan may draw several; one of other halls is refused as the wrong plan), for the planner
 * to review and place; or the drawing itself as DXF. Read-only: the planner's rule-checked save is
 * what changes a plan.
 */
@Controller({ path: 'events/:eventId/halls/:eventHallId/plan/drawing', version: '1' })
export class DrawingImportController {
  constructor(
    private readonly plans: StallPlansService,
    private readonly drawings: DrawingImportService,
    private readonly checks: DrawingCheckService,
  ) {}

  @Throttle(READ_LIMIT)
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DRAWING_BYTES, files: 1 } }))
  async stalls(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
    @UploadedFile() file: Upload,
    @Query('page') page: string | undefined,
  ): Promise<HallStalls & { aiCheck: AiCheck }> {
    const hall = await this.plans.editableHall(eventId, eventHallId, user);
    // Only this hall's stalls: a plan may draw several halls, or be of another one (a 422).
    const { stalls, overlay } = await this.drawings.hallStalls(drawingOf(file), pageOf(page), hall);
    const pitch = stalls.groups[0]?.pitchX ?? 1;
    const aiCheck = await this.checks.check(overlay, stalls.stalls, stalls.unresolved, pitch);
    return { ...stalls, aiCheck };
  }

  /** The plan's drawing as a DXF file (the answer is the file, not the usual envelope). */
  @RawResponse()
  @Throttle(READ_LIMIT)
  @Post('dxf')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/dxf')
  @Header('Content-Disposition', 'attachment; filename="plan.dxf"')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DRAWING_BYTES, files: 1 } }))
  async dxf(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
    @UploadedFile() file: Upload,
    @Query('page') page: string | undefined,
  ): Promise<StreamableFile> {
    await this.plans.editableHall(eventId, eventHallId, user);
    const dxf = await this.drawings.dxf(drawingOf(file), pageOf(page));
    return new StreamableFile(Buffer.from(dxf, 'utf8'));
  }
}

function drawingOf(file: Upload): Uint8Array {
  if (!file?.buffer?.length) {
    throw new BadRequestException('Attach the plan as a PDF or DXF file in the "file" field.');
  }
  // The PDF header may follow a little junk, but must be within the first 1024 bytes.
  const isPdf = file.buffer.subarray(0, 1024).includes('%PDF-');
  if (!isPdf && !isAsciiDxf(file.buffer)) {
    throw new BadRequestException('The file is not a PDF or an ASCII DXF.');
  }
  // A copy: pdf.js takes ownership of (and may detach) the buffer it is given.
  return new Uint8Array(file.buffer);
}

function pageOf(raw: string | undefined): number {
  const page = raw === undefined || raw === '' ? 1 : Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > 1000) {
    throw new BadRequestException('page must be a page number (1, 2, ...).');
  }
  return page;
}
