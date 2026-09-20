import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * Request body for POST /api/layout/save and PUT /api/layout/{id}
 * (LayoutSaveRequest.java). Unlike the Java, these are NOT persistence entities (ADR-008).
 *
 * Every property is optional ON PURPOSE. The pipe only rejects wrong TYPES (a string where a
 * number belongs -> 400, ADR-014). Missing or null values must reach LayoutValidator, because
 * the Java reports them with specific messages in a specific order ("Hall data is required.",
 * "Hall name is required.", ...) and those strings are contract (ADR-010).
 *
 * A property needs at least one decorator to survive `whitelist: true`.
 */
const FINITE = { allowNaN: false, allowInfinity: false };

export class HallDto {
  /** Sent by the frontends when numeric; ignored on every write path (BR-18). */
  @IsOptional()
  id?: unknown;

  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsString()
  shape?: string | null;

  @IsOptional()
  @IsNumber(FINITE)
  width?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  length?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  radius?: number | null;

  @IsOptional()
  @IsArray()
  blockedAreas?: unknown[] | null;
}

export class StallDto {
  /** Ignored (BR-18). */
  @IsOptional()
  id?: unknown;

  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsNumber(FINITE)
  width?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  length?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  height?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  posX?: number | null;

  @IsOptional()
  @IsNumber(FINITE)
  posZ?: number | null;

  @IsOptional()
  @IsString()
  color?: string | null;

  @IsOptional()
  @IsString()
  gateSide?: string | null;

  @IsOptional()
  @IsArray()
  openSides?: unknown[] | null;
}

export class LayoutSaveRequestDto {
  @IsOptional()
  @IsString()
  layoutName?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => HallDto)
  hall?: HallDto | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StallDto)
  stalls?: Array<StallDto | null> | null;
}
