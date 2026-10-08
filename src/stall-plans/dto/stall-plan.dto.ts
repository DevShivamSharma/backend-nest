import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { RuleOverrideDto } from '../../rules/dto/rules.dto';
import { STALL_SIDES, StallSide } from '../../rules/rule-engine';
import { MAX_HALL_SIDE } from '../../venues/floor/hall-floor';
import { STALL_TYPES, StallType } from '../stall-plan.entity';

const COORDINATE = { allowNaN: false, allowInfinity: false };

/** One stall of a plan; `id` is absent for a stall drawn since the plan was loaded. */
export class PlanStallDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @Trim()
  @IsString()
  @Length(1, 40)
  number!: string;

  @IsNumber(COORDINATE)
  @Min(-MAX_HALL_SIDE)
  @Max(MAX_HALL_SIDE)
  x!: number;

  @IsNumber(COORDINATE)
  @Min(-MAX_HALL_SIDE)
  @Max(MAX_HALL_SIDE)
  y!: number;

  @IsNumber(COORDINATE)
  @IsPositive()
  @Max(MAX_HALL_SIDE)
  width!: number;

  @IsNumber(COORDINATE)
  @IsPositive()
  @Max(MAX_HALL_SIDE)
  depth!: number;

  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(STALL_SIDES, { each: true })
  openSides!: StallSide[];

  @IsOptional()
  @EmptyToNull()
  @IsIn(STALL_TYPES)
  stallType?: StallType | null;
}

/** The whole plan as the editor holds it. `revision` 0 saves a hall's first plan. */
export class SavePlanDto {
  @IsInt()
  @Min(0)
  revision!: number;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => PlanStallDto)
  stalls!: PlanStallDto[];

  /** Omitted keeps the plan's current overrides. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RuleOverrideDto)
  overrides?: RuleOverrideDto[];
}

/** Approve, publish or reopen the plan at the revision the member looked at. */
export class PlanRevisionDto {
  @IsInt()
  @Min(1)
  revision!: number;
}
