import {
  BadRequestException,
  Controller,
  ForbiddenException,
  UnprocessableEntityException,
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

import {
  AllowEventRoles,
  CurrentAccess,
  OrgAccess,
  RequirePermissions,
} from '../../access/org-access.decorators';
import type { OrgAccessContext } from '../../common/http/authenticated-request';
import { StallPlansService } from '../stall-plans.service';
import { DrawingImportService } from './drawing-import.service';
import { forHall, type HallStalls, WrongPlanError } from './hall-match';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Each read is seconds of CPU. */
const READ_LIMIT = { default: { limit: 6, ttl: 60_000 } };

type Upload = { buffer?: Buffer; size?: number } | undefined;

/**
 * A CAD plan (PDF exported from AutoCAD) read for a hall's stall plan: the stalls it draws of
 * THIS hall (a plan may draw several; one of other halls is refused as the wrong plan), for the
 * planner to review and place; or the drawing itself as DXF.
 * Read-only: the planner's rule-checked save is what changes a plan.
 */
@OrgAccess('events.view', 'layouts.view')
@AllowEventRoles()
@Controller('orgs/:slug/events/:id/halls/:hallId/plan/drawing')
export class DrawingImportController {
  constructor(
    private readonly plans: StallPlansService,
    private readonly drawings: DrawingImportService,
  ) {}

  @RequirePermissions('events.view', 'layouts.edit')
  @Throttle(READ_LIMIT)
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES, files: 1 } }))
  async stalls(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @UploadedFile() file: Upload,
    @Query('page') page: string | undefined,
  ): Promise<HallStalls> {
    const hall = await this.mayEdit(access, id, hallId);
    const result = await this.drawings.stalls(pdfOf(file), pageOf(page));
    try {
      // Only this hall's stalls: a plan may draw several halls, or be of another one.
      return forHall(result, hall.name, hall.code);
    } catch (e) {
      if (e instanceof WrongPlanError) throw new UnprocessableEntityException(e.message);
      throw e;
    }
  }

  @RequirePermissions('events.view', 'layouts.edit')
  @Throttle(READ_LIMIT)
  @Post('dxf')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/dxf')
  @Header('Content-Disposition', 'attachment; filename="plan.dxf"')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES, files: 1 } }))
  async dxf(
    @CurrentAccess() access: OrgAccessContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hallId', ParseUUIDPipe) hallId: string,
    @UploadedFile() file: Upload,
    @Query('page') page: string | undefined,
  ): Promise<StreamableFile> {
    await this.mayEdit(access, id, hallId);
    const dxf = await this.drawings.dxf(pdfOf(file), pageOf(page));
    return new StreamableFile(Buffer.from(dxf, 'utf8'));
  }

  /** Also the access check: a hall the member cannot see is not found. */
  private async mayEdit(
    access: OrgAccessContext,
    id: string,
    hallId: string,
  ): Promise<{ name: string; code: string | null }> {
    const view = await this.plans.get(access, id, hallId);
    if (!view.canEdit) {
      throw new ForbiddenException(view.readOnlyReason ?? 'This plan is read-only for you.');
    }
    return { name: view.hall.hall.name, code: view.hall.hall.code };
  }
}

function pdfOf(file: Upload): Uint8Array {
  if (!file?.buffer?.length) {
    throw new BadRequestException('Attach the plan as a PDF file in the "file" field.');
  }
  // The PDF header may follow a little junk, but must be within the first 1024 bytes.
  if (!file.buffer.subarray(0, 1024).includes('%PDF-')) {
    throw new BadRequestException('The file is not a PDF.');
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
