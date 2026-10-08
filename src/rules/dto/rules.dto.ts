import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { EVENT_TYPES, EventType, RULE_IDS, RuleId } from '../rule-catalogue';
import { STALL_SIDES, StallSide } from '../rule-engine';

class PassageWidthDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  B2B!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  B2C!: number;
}

/** Every value of a rule set; limits are checked by the service, with their wording. */
export class RuleValuesDto {
  @ValidateNested()
  @Type(() => PassageWidthDto)
  passageWidth!: PassageWidthDto;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  peripheralClearance!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  curtainClearance!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  facilityClearance!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  partitionClearance!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  emergencyExitClearance!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  sizeStep!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  maxUtilization!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  eventSeparation!: number;

  @IsBoolean()
  foyerConstruction!: boolean;
}

export class RuleReferenceDto {
  @Trim()
  @IsString()
  @Length(1, 200)
  document!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(60)
  section?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

/** Changes to an organisation's rules; whatever is left out stays as it is. */
export class UpdateRulesDto {
  /** Rule id -> on or off; checked against the catalogue by the service. */
  @IsOptional()
  @IsObject()
  switches?: Record<string, boolean>;

  @IsOptional()
  @ValidateNested()
  @Type(() => RuleValuesDto)
  values?: RuleValuesDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RuleReferenceDto)
  references?: RuleReferenceDto[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  drawingProfile?: string;
}

export class StallDto {
  @IsString()
  @Length(1, 60)
  id!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  number?: string | null;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  y!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  width!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  depth!: number;

  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(STALL_SIDES, { each: true })
  openSides!: StallSide[];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  rotation?: number;
}

export class RuleOverrideDto {
  @IsIn(RULE_IDS)
  ruleId!: RuleId;

  /** Omitted or null: every stall. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  stallIds?: string[] | null;

  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

/** Stalls to check on a hall against the organisation's rules. */
export class CheckLayoutDto {
  @IsUUID('4')
  hallId!: string;

  @IsIn(EVENT_TYPES)
  eventType!: EventType;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StallDto)
  stalls!: StallDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RuleOverrideDto)
  overrides?: RuleOverrideDto[];
}
