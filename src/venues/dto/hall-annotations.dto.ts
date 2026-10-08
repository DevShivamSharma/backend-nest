import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { HEX_COLOR, Trim } from '../../common/validation';
import { MAX_HALL_SIDE } from '../floor/hall-floor';

class AnnotationPositionDto {
  @IsNumber() @Min(-MAX_HALL_SIDE * 4) @Max(MAX_HALL_SIDE * 4) x!: number;
  @IsNumber() @Min(-MAX_HALL_SIDE * 4) @Max(MAX_HALL_SIDE * 4) y!: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(MAX_HALL_SIDE) width?: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(MAX_HALL_SIDE) height?: number;
}
class HallLabelDto extends AnnotationPositionDto {
  @Trim() @IsString() @Length(1, 200) text!: string;
}
class HallIconDto {
  @IsIn([
    'toilet',
    'toilet-male',
    'toilet-female',
    'stairs',
    'lift',
    'emergency-exit',
    'drinking-water',
    'entry-up',
    'information',
  ])
  kind!: string;
  @Trim() @IsString() @Length(1, 200) label!: string;
}
class HallIconGroupDto extends AnnotationPositionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HallIconDto)
  icons!: HallIconDto[];
}
class HallLegendDto {
  @Trim() @IsString() @Length(1, 200) label!: string;
  @IsOptional() @IsString() @Matches(HEX_COLOR) color?: string;
  @IsBoolean() showInView!: boolean;
}
export class HallAnnotationsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => HallLabelDto)
  labels!: HallLabelDto[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => HallIconGroupDto)
  iconGroups!: HallIconGroupDto[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => HallLegendDto)
  legend!: HallLegendDto[];
}
