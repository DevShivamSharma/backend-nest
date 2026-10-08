import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { MAX_HALL_SIDE } from '../floor/hall-floor';
import { HallAnnotationsDto } from './hall-annotations.dto';

export class CreateVenueDto {
  @Trim()
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  address?: string | null;
}

export class UpdateVenueDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  address?: string | null;
}

export class HallUsesDto {
  @IsOptional()
  @IsBoolean()
  fnb?: boolean;

  @IsOptional()
  @IsBoolean()
  branding?: boolean;

  @IsOptional()
  @IsBoolean()
  horseshoe?: boolean;

  @IsOptional()
  @IsBoolean()
  openArea?: boolean;
}

class HallDetailsDto {
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  level?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => HallUsesDto)
  uses?: HallUsesDto;
}

/** A hall drawn from nothing: an empty rectangle of the given size. */
export class CreateHallDto extends HallDetailsDto {
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(MAX_HALL_SIDE)
  width!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(MAX_HALL_SIDE)
  depth!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => HallAnnotationsDto)
  annotations?: HallAnnotationsDto;
}

export class UpdateHallDto extends HallDetailsDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HallAnnotationsDto)
  annotations?: HallAnnotationsDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** About 12 MB of text: ITPO's whole `T_HALL_LAYOUTS` export is under 2 MB. */
const MAX_IMPORT_TEXT = 12_000_000;

export class ItpoFileDto {
  @IsIn(['csv', 'json'])
  format!: 'csv' | 'json';

  @IsString()
  @MaxLength(MAX_IMPORT_TEXT)
  content!: string;
}

/** One hall of the file to import, as the person confirmed it. */
export class ItpoImportHallDto {
  @IsString()
  @Matches(/^[\w-]{1,40}$/)
  externalId!: string;

  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  level?: string | null;
}

export class ItpoImportDto extends ItpoFileDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItpoImportHallDto)
  halls!: ItpoImportHallDto[];
}

/** Halls of one venue to delete together. */
export class DeleteHallsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  hallIds!: string[];
}
