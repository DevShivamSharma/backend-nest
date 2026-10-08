import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ItpoImportHallDto } from '../dto/venue.dto';
import type { JsonMapping } from './adapter';
export class JsonFileDto {
  @IsString() @MaxLength(12_000_000) content!: string;
  @IsOptional() @IsObject() mapping?: JsonMapping;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}
export class JsonImportDto extends JsonFileDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItpoImportHallDto)
  halls!: ItpoImportHallDto[];
  @IsString() @Length(64, 64) previewToken!: string;
  @IsBoolean() reviewed!: boolean;
}
