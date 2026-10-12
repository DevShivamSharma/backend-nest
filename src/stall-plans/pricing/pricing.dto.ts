import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';

/** ₹ up to a hundred crore, in paise. */
const MAX_RUPEES = 1_000_000_000;
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class PriceRatesDto {
  @IsNumber(money)
  @Min(0)
  @Max(MAX_RUPEES)
  bareRate!: number;

  @IsNumber(money)
  @Min(0)
  @Max(MAX_RUPEES)
  shellRate!: number;

  @IsNumber(money)
  @Min(0)
  @Max(1000)
  side2Percent!: number;

  @IsNumber(money)
  @Min(0)
  @Max(1000)
  side3Percent!: number;

  @IsNumber(money)
  @Min(0)
  @Max(1000)
  side4Percent!: number;

  @IsNumber(money)
  @Min(0)
  @Max(MAX_RUPEES)
  catalogueCharge!: number;

  @IsOptional()
  @IsNumber(money)
  @Min(0)
  @Max(MAX_RUPEES)
  fnbPrice?: number | null;
}

/** The whole rate card: General, and Premium and Marquee when they are priced apart. */
export class PriceCardDto {
  /** Every card has General rates; Premium and Marquee are optional. */
  @IsDefined({ message: 'The rate card needs General rates.' })
  @ValidateNested()
  @Type(() => PriceRatesDto)
  general!: PriceRatesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRatesDto)
  premium?: PriceRatesDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRatesDto)
  marquee?: PriceRatesDto | null;
}

export class StallPriceDto {
  @IsUUID()
  stallId!: string;

  /** ₹; null takes the stall's own price away, so the rate card prices it. */
  @IsOptional()
  @IsNumber(money)
  @Min(0)
  @Max(MAX_RUPEES)
  price!: number | null;

  @IsOptional()
  @Trim()
  @EmptyToNull()
  @IsString()
  @Length(1, 300)
  note?: string | null;
}

/** Prices set on stalls, or taken off them; stalls not named keep theirs. */
export class SetStallPricesDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StallPriceDto)
  prices!: StallPriceDto[];
}
