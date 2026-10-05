import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Optional body of POST /api/layout/{id}/stalls/{stallNumber}/book: SelfCare's own ids and prices,
 * named exactly as its database columns (see selfcare-booking.ts). An empty body still books.
 */
export class SelfcarePricingDto {
  @IsOptional() @IsNumber() @Min(0) bare_rate!: number | null;
  @IsOptional() @IsNumber() @Min(0) shell_rate!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) two_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) three_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) four_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) catlog_entry_charge!: number | null;
  @IsBoolean() corner_charges_applicable!: boolean;
}

export class SelfcareTaxDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) cgst_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) sgst_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) igst_percent!: number | null;
}

export class BookStallDto {
  @IsOptional() @IsString() @MaxLength(64) expectedQuote?: string;
  @IsOptional() @IsUUID() user_id?: string | null;
  @IsOptional() @IsUUID() event_id?: string | null;
  @IsOptional() @IsString() @MaxLength(300) event_name?: string | null;
  @IsOptional() @IsUUID() event_hall_id?: string | null;
  @IsOptional() @IsInt() @Min(1) hall_id?: number | null;
  @IsOptional() @IsUUID() stall_id?: string | null;
  @IsOptional() @IsIn(['shell', 'bare']) stall_type?: 'shell' | 'bare' | null;
  @IsOptional() @IsInt() @Min(1) product_category_id?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SelfcarePricingDto)
  pricing?: SelfcarePricingDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SelfcareTaxDto)
  tax?: SelfcareTaxDto | null;
}
