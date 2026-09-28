import { Module } from '@nestjs/common';

import { PdfImportController } from './pdf-import.controller';
import { PdfImportService } from './pdf-import.service';

@Module({ controllers: [PdfImportController], providers: [PdfImportService] })
export class PdfImportModule {}
