import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateBy,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { STALL_SIDES, StallSide } from '../../rules/rule-engine';
import {
  PLAN_OBJECT_KINDS,
  PlanObjectKind,
  STALL_SCHEMES,
  StallScheme,
} from '../stall-plan.entity';

export const MAX_ZONES = 200;
export const MAX_STALLS = 3000;
export const MAX_SEATS = 20000;
export const MAX_OBJECTS = 2000;
/** Floor metres; halls are at most 2 km a side. */
const MAX_COORD = 5000;

const COLOR = /^#[0-9a-fA-F]{6}$/;

const FINITE = { allowNaN: false, allowInfinity: false };

/** Every item is a point: two finite numbers within the floor's reach. */
function IsPoints(message = 'A zone outline is a list of [x, y] points in metres.') {
  return ValidateBy({
    name: 'isPoints',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD),
        ),
      defaultMessage: () => message,
    },
  });
}

export class PlanZoneDto {
  @IsUUID('4')
  id!: string;

  @Trim()
  @IsString()
  @Length(1, 80)
  name!: string;

  @Matches(COLOR, { message: 'A zone colour is written #rrggbb.' })
  color!: string;

  /** Corners in order, floor metres; the outline closes by itself. */
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(500)
  @IsPoints()
  polygon!: Array<[number, number]>;
}

export class PlanStallDto {
  @IsUUID('4')
  id!: string;

  @IsOptional()
  @IsUUID('4')
  zoneId?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  islandNumber?: string | null;

  @Trim()
  @IsString()
  @Length(1, 20)
  stallNumber!: string;

  @IsNumber(FINITE)
  @Min(-MAX_COORD)
  @Max(MAX_COORD)
  x!: number;

  @IsNumber(FINITE)
  @Min(-MAX_COORD)
  @Max(MAX_COORD)
  y!: number;

  @IsNumber(FINITE)
  @Min(0.1)
  @Max(MAX_COORD)
  width!: number;

  @IsNumber(FINITE)
  @Min(0.1)
  @Max(MAX_COORD)
  depth!: number;

  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(STALL_SIDES, { each: true })
  openSides!: StallSide[];

  @IsIn(STALL_SCHEMES)
  scheme!: StallScheme;

  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds!: string[];

  @IsBoolean()
  isPremium!: boolean;

  @IsBoolean()
  isBlocked!: boolean;

  @IsBoolean()
  isFnb!: boolean;

  @IsBoolean()
  isBranding!: boolean;

  @IsBoolean()
  isHorseshoe!: boolean;

  @IsBoolean()
  isMarqueeAvailable!: boolean;

  @IsBoolean()
  isRestrictedForOverseas!: boolean;

  @IsBoolean()
  isActive!: boolean;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(200)
  location?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class PlanSeatDto {
  @IsUUID('4')
  id!: string;

  @IsOptional()
  @IsUUID('4')
  zoneId?: string | null;

  @Matches(/^[A-Z]{1,4}$/, { message: 'A seat row is 1 to 4 capital letters.' })
  rowLabel!: string;

  @IsInt()
  @Min(1)
  @Max(99999)
  seatNumber!: number;

  @IsNumber(FINITE)
  @Min(-MAX_COORD)
  @Max(MAX_COORD)
  x!: number;

  @IsNumber(FINITE)
  @Min(-MAX_COORD)
  @Max(MAX_COORD)
  y!: number;

  @IsNumber(FINITE)
  @Min(0.1)
  @Max(MAX_COORD)
  width!: number;

  @IsNumber(FINITE)
  @Min(0.1)
  @Max(MAX_COORD)
  depth!: number;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string | null;
}

export class PlanObjectDto {
  @IsUUID('4')
  id!: string;

  @IsIn(PLAN_OBJECT_KINDS)
  kind!: PlanObjectKind;

  /** Floor metres. How many, and what they mean, depends on the kind: see the service. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsPoints('A drawing is a list of [x, y] points in metres.')
  points!: Array<[number, number]>;

  /** The label; a text drawing needs one, the other kinds may have one. */
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(120)
  text?: string | null;

  @Matches(COLOR, { message: 'A drawing colour is written #rrggbb.' })
  color!: string;
}

class PlanContentDto {
  @IsArray()
  @ArrayMaxSize(MAX_ZONES)
  @ValidateNested({ each: true })
  @Type(() => PlanZoneDto)
  zones!: PlanZoneDto[];

  @IsArray()
  @ArrayMaxSize(MAX_STALLS)
  @ValidateNested({ each: true })
  @Type(() => PlanStallDto)
  stalls!: PlanStallDto[];

  @IsArray()
  @ArrayMaxSize(MAX_SEATS)
  @ValidateNested({ each: true })
  @Type(() => PlanSeatDto)
  seats!: PlanSeatDto[];

  @IsArray()
  @ArrayMaxSize(MAX_OBJECTS)
  @ValidateNested({ each: true })
  @Type(() => PlanObjectDto)
  objects!: PlanObjectDto[];
}

/** The whole plan, replacing what is saved. `revision` is the one the planner opened. */
/** Publishes the saved plan; `revision` is the one the planner shows as saved. */
export class PublishPlanDto {
  @IsInt()
  @Min(1)
  revision!: number;
}

export class SavePlanDto extends PlanContentDto {
  @IsInt()
  @Min(0)
  revision!: number;
}

/**
 * A plan as the planner has it, with what was just added or changed. Only rules broken by
 * those (or by the plan as a whole) come back, so the planner can refuse the change.
 */
export class CheckPlanDto extends PlanContentDto {
  @IsArray()
  @ArrayMaxSize(MAX_STALLS + MAX_SEATS)
  @IsUUID('4', { each: true })
  changed!: string[];
}
