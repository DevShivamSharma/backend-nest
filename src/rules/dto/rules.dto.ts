import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

class PassageWidthDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  B2B!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  B2C!: number;
}

/** Every value of the rule set; limits are checked by the service, with their wording. */
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

  /** Absent from clients that predate the Pillars rule: the stored or default value stays. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  pillarClearance?: number;

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
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  document!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(60)
  section?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

/** Changes to the rules; whatever is left out stays as it is. */
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

/** An event's own switches: rule id -> on or off for this event, or null to follow the default. */
export class SetEventRulesDto {
  @IsObject()
  switches!: Record<string, boolean | null>;
}
