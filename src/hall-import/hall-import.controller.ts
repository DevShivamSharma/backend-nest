import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { HallImportResult } from './hall-analysis';
import type { HallPlanFormat } from './hall-import.job';
import { HallImportService } from './hall-import.service';

export const MAX_DXF_BYTES = 80 * 1024 * 1024;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/halls/import (multipart, field "file"): reads a hall floor plan (DXF or vector PDF)
 * and returns hall drafts — outline, toilets, lifts, stairs, gates, exits, curtains, pillars,
 * legend — in the planner's structure, for review. Read-only: the reviewed hall is saved with
 * POST /api/halls.
 */
@Controller('halls')
export class HallImportController {
  private readonly clients = new Map<string, { start: number; count: number }>();

  constructor(private readonly service: HallImportService) {}

  @Post('import')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DXF_BYTES, files: 1, fields: 2, parts: 3 } }),
  )
  async import(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; size?: number } | undefined,
    @Req() request: Request,
  ): Promise<HallImportResult> {
    this.rateLimit(request);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Attach the floor plan (DXF or PDF) in the "file" field.');
    }
    const fileName = (file.originalname ?? 'plan').slice(0, 200);
    const format = detectFormat(file.buffer, fileName);
    if (format === 'pdf' && file.buffer.length > MAX_PDF_BYTES) {
      throw new BadRequestException('The PDF is larger than 25 MB.');
    }
    // A copy: the reader (and pdf.js) may take ownership of the buffer it is given.
    return this.service.analyse(new Uint8Array(file.buffer), format, fileName);
  }

  /** Four analyses a minute per client: each one is seconds of CPU. */
  private rateLimit(request: Request): void {
    const now = Date.now();
    for (const [key, entry] of this.clients)
      if (now - entry.start >= 60_000) this.clients.delete(key);
    const key = request.ip ?? request.socket?.remoteAddress ?? 'local';
    const entry = this.clients.get(key) ?? { start: now, count: 0 };
    if (entry.count >= 4 || (!this.clients.has(key) && this.clients.size >= 10_000)) {
      throw new HttpException('Too many plan uploads. Try again in a minute.', 429);
    }
    entry.count++;
    this.clients.set(key, entry);
  }
}

/** By content, not by the name alone: a renamed file is still recognised (or refused). */
export function detectFormat(buffer: Buffer, fileName: string): HallPlanFormat {
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (/^AC10\d\d/.test(head)) {
    throw new UnsupportedMediaTypeException(
      'DWG files cannot be read yet. In AutoCAD, use Save As → DXF (ASCII) and upload the DXF.',
    );
  }
  if (/^\s*(999\s*\r?\n[^\n]*\r?\n\s*)?0\s*\r?\n\s*SECTION/.test(head) || head.startsWith('AutoCAD Binary DXF')) {
    return 'dxf';
  }
  if (/\.dwg$/i.test(fileName)) {
    throw new UnsupportedMediaTypeException(
      'DWG files cannot be read yet. In AutoCAD, use Save As → DXF (ASCII) and upload the DXF.',
    );
  }
  throw new UnsupportedMediaTypeException('Upload the floor plan as a DXF or a PDF file.');
}
