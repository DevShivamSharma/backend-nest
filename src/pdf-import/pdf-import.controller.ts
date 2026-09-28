import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { PdfImportService } from './pdf-import.service';
import type { ExtractionResult } from './stall-extraction';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/layout/pdf-import (multipart, field "file", optional ?page=N): reads a CAD hall plan
 * PDF and returns the stalls it finds, with calibration, conflicts and uncertain items, for the
 * planner to review. Read-only: nothing is saved until the user confirms in the planner, which
 * then saves through the normal, fully validated layout save.
 */
@Controller('layout')
export class PdfImportController {
  private readonly clients = new Map<string, { start: number; count: number }>();

  constructor(private readonly service: PdfImportService) {}

  @Post('pdf-import')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 2, parts: 3 } }),
  )
  async import(
    @UploadedFile() file: { buffer?: Buffer; size?: number } | undefined,
    @Query('page') pageParam: string | undefined,
    @Req() request: Request,
  ): Promise<ExtractionResult> {
    this.rateLimit(request);
    if (!file?.buffer?.length)
      throw new BadRequestException('Attach the plan as a PDF file in the "file" field.');
    // The PDF header may follow a little junk, but must be within the first 1024 bytes.
    if (!file.buffer.subarray(0, 1024).includes('%PDF-')) {
      throw new BadRequestException('The file is not a PDF.');
    }
    const page = pageParam === undefined || pageParam === '' ? 1 : Number(pageParam);
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
      throw new BadRequestException('page must be a page number (1, 2, ...).');
    }
    // A copy: pdf.js takes ownership of (and may detach) the buffer it is given.
    return this.service.extract(new Uint8Array(file.buffer), page);
  }

  /** Six imports a minute per client: each one is seconds of CPU. */
  private rateLimit(request: Request): void {
    const now = Date.now();
    for (const [key, entry] of this.clients)
      if (now - entry.start >= 60_000) this.clients.delete(key);
    const key = request.ip ?? request.socket?.remoteAddress ?? 'local';
    const entry = this.clients.get(key) ?? { start: now, count: 0 };
    if (entry.count >= 6 || (!this.clients.has(key) && this.clients.size >= 10_000)) {
      throw new HttpException('Too many plan imports. Try again in a minute.', 429);
    }
    entry.count++;
    this.clients.set(key, entry);
  }
}
