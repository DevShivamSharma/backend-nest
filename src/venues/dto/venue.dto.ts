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
}

export class UpdateHallDto extends HallDetailsDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;
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

/** Options sent with an uploaded plan (multipart form fields, so everything arrives as text). */
export class DrawingUploadDto {
  /** Notes for the reader of the plan's texts, e.g. "the legend is in Hindi". */
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(1000)
  instructions?: string | null;

  /** Read the words of scanned pages (slower). Default true. */
  @IsOptional()
  @IsIn(['true', 'false'])
  readText?: 'true' | 'false';
}

class CalibrateDto {
  @IsInt()
  @Min(1)
  page!: number;

  /** Metres per map unit; null clears the calibration. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  metresPerUnit!: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  detail?: string;
}

class CutDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  y!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  width!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  height!: number;
}

class CutsDto {
  @IsInt()
  @Min(1)
  page!: number;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CutDto)
  cuts!: CutDto[];
}

class AssignDto {
  @IsInt()
  @Min(1)
  page!: number;

  @IsInt()
  @Min(0)
  part!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  hall!: string | null;

  @IsIn(['floor', 'foyer', 'circulation'])
  role!: 'floor' | 'foyer' | 'circulation';
}

class NameDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @Trim()
  @IsString()
  @Length(0, 120)
  name!: string;
}

class GroupChoiceDto {
  @IsInt()
  @Min(1)
  page!: number;

  @IsInt()
  @Min(0)
  id!: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  choice!: string | null;
}

class HoleChoiceDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  choice!: string | null;
}

class TextChoiceDto {
  @IsInt()
  @Min(1)
  page!: number;

  @IsInt()
  @Min(0)
  index!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind!: string | null;
}

class AcknowledgeDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  checks!: string[];
}

/** One change on the review screen. */
export class ReviewPatchDto {
  @IsOptional() @ValidateNested() @Type(() => CalibrateDto) calibrate?: CalibrateDto;
  @IsOptional() @ValidateNested() @Type(() => CutsDto) cuts?: CutsDto;
  @IsOptional() @ValidateNested() @Type(() => AssignDto) assign?: AssignDto;
  @IsOptional() @ValidateNested() @Type(() => NameDto) name?: NameDto;
  @IsOptional() @ValidateNested() @Type(() => GroupChoiceDto) group?: GroupChoiceDto;
  @IsOptional() @ValidateNested() @Type(() => HoleChoiceDto) hole?: HoleChoiceDto;
  @IsOptional() @ValidateNested() @Type(() => TextChoiceDto) text?: TextChoiceDto;
  @IsOptional() @ValidateNested() @Type(() => AcknowledgeDto) acknowledge?: AcknowledgeDto;
}

class CommitHallDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

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

  /** "new", or the id of a hall of this venue to add a floor version to. */
  @Matches(/^(new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)
  target!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  acknowledge?: string[];
}

/** Halls to save from a reviewed plan. */
export class PlanCommitDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CommitHallDto)
  halls!: CommitHallDto[];
}

export class PlanDiffDto {
  @IsString()
  @MaxLength(40)
  key!: string;

  @IsUUID('4')
  hallId!: string;
}
