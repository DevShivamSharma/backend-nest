import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { RATE_TYPES, RateType } from './rate-card';

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };

export class RatePeriodDto {
  /** Present for a row that exists; a new row has none. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsIn(RATE_TYPES)
  type!: RateType;

  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  endAt!: string;

  @IsNumber(MONEY)
  @Min(0)
  @Max(10_000_000)
  bareRate!: number;

  @IsNumber(MONEY)
  @Min(0)
  @Max(10_000_000)
  shellRate!: number;

  @IsNumber(MONEY)
  @Min(0)
  @Max(1000)
  side2Percent!: number;

  @IsNumber(MONEY)
  @Min(0)
  @Max(1000)
  side3Percent!: number;

  @IsNumber(MONEY)
  @Min(0)
  @Max(1000)
  side4Percent!: number;

  @IsNumber(MONEY)
  @Min(0)
  @Max(100_000_000)
  catalogueCharge!: number;

  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  @Max(100_000_000)
  fnbPrice!: number | null;
}

export class SaveRateCardDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RatePeriodDto)
  periods!: RatePeriodDto[];
}
