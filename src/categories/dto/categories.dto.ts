import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { CATEGORY_STATUSES, CategoryStatus } from '../category.entity';

/** Most rows one import takes. */
export const MAX_IMPORT_ROWS = 1000;

export class CreateCategoryDto {
  @Trim()
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsIn(CATEGORY_STATUSES)
  status?: CategoryStatus;

  /** The category's id in SelfCare (`T_CODE_MASTER.id`); null unlinks it. */
  @IsOptional()
  @EmptyToNull()
  @Matches(/^\d{1,12}$/, { message: 'A SelfCare id is a number, e.g. 56.' })
  itpoId?: string | null;}

export class UpdateCategoryDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsIn(CATEGORY_STATUSES)
  status?: CategoryStatus;

  /** The category's id in SelfCare (`T_CODE_MASTER.id`); null unlinks it. */
  @IsOptional()
  @EmptyToNull()
  @Matches(/^\d{1,12}$/, { message: 'A SelfCare id is a number, e.g. 56.' })
  itpoId?: string | null;}

/** Rows read from the venue's CSV by the browser; names already listed are skipped. */
export class ImportCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CreateCategoryDto)
  rows!: CreateCategoryDto[];
}
