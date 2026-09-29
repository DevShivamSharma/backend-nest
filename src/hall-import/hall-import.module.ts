import { Module } from '@nestjs/common';
import { HallImportController } from './hall-import.controller';
import { HallImportService } from './hall-import.service';

/** POST /api/halls/import: floor plan (DXF / PDF) -> hall drafts for review. */
@Module({ controllers: [HallImportController], providers: [HallImportService] })
export class HallImportModule {}
