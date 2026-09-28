import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

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

  /** Rule-driven geometry. Shapes are checked by validateHallGeometry(), not here. */
  @IsOptional()
  @IsArray()
  boundary?: unknown[] | null;

  @IsOptional()
  @IsArray()
  zones?: unknown[] | null;

  @IsOptional()
  @IsArray()
  openings?: unknown[] | null;

  @IsOptional()
  @IsArray()
  markers?: unknown[] | null;

  @IsOptional()
  @IsArray()
  amenities?: unknown[] | null;

  /** The plan's north arrow. Checked by validateHallGeometry(). */
  @IsOptional()
  @IsObject()
  compass?: Record<string, unknown> | null;

  /** The plan's legend rows. Checked by validateHallGeometry(). */
  @IsOptional()
  @IsArray()
  legends?: unknown[] | null;

  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown> | null;
}

export class StallDto {
  /**
   * Custom (polygon) stall outline, local metres before rotation, relative to (posX, posZ).
   * Checked and canonicalised by the validator (stall-footprint.ts). Omit for a rectangle.
   */
  @IsOptional()
  @IsArray()
  footprint?: unknown[] | null;

  /** Open edges of a custom stall: indices into `footprint` (edge i = point i -> i + 1). */
  @IsOptional()
  @IsArray()
  openEdges?: unknown[] | null;

  /** Clockwise degrees in the X-right/Z-down plan; local sides rotate with the stall. */
  @IsOptional()
  @IsNumber(FINITE)
  rotation?: number | null;

  /** Echo-only lineage. The server restores this from the issued identifier on PUT. */
  @IsOptional()
  @IsString()
  parentStallNumber?: string | null;

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

  /** Persisted number of an existing stall. Kept only if it already belongs to this layout. */
  @IsOptional()
  @IsString()
  stallNumber?: string | null;

  @IsOptional()
  @IsString()
  status?: string | null;

  @IsOptional()
  @IsString()
  stallTypeId?: string | null;
}

export class LayoutSaveRequestDto {
  @IsOptional()
  @IsString()
  layoutName?: string | null;

  /** 'B2B' (default) or 'B2C'. */
  @IsOptional()
  @IsString()
  eventType?: string | null;

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

export class SplitStallDto {
  @IsString()
  idempotencyKey!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StallDto)
  children!: StallDto[];
}
