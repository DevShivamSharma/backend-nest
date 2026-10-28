import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

import type { Corner } from '../domain/hall-grid';

/** The most pictures a hall has. */
export const MAX_HALL_IMAGES = 20;
/** `T_DOCUMENTS.path` is 200 characters. */
const MAX_URL_LENGTH = 200;

/** A picture of a hall: where it is kept (S3), and whether it is the cover or one of the gallery. */
export class HallImageDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @MaxLength(MAX_URL_LENGTH)
  url!: string;

  @IsIn(['cover', 'gallery'])
  kind!: 'cover' | 'gallery';
}

/** The longest side of a hall, in metres. */
export const MAX_HALL_SIDE = 2000;

/** Each corner of an outline is [x, y]: two finite numbers. */
const IsCorners = () =>
  ValidateBy({
    name: 'isCorners',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every(
          (c) =>
            Array.isArray(c) &&
            c.length === 2 &&
            c.every((n) => typeof n === 'number' && Number.isFinite(n)),
        ),
      defaultMessage: () => 'A hall outline is a list of [x, y] corners in metres.',
    },
  });

export class CreateHallDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  /** Metres across (x); a fraction is allowed. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(MAX_HALL_SIDE)
  width!: number;

  /** Metres down (y); a fraction is allowed. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(MAX_HALL_SIDE)
  depth!: number;

  /** Custom shape: the corners of the hall's outline, in metres. Left out, the hall is a rectangle. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(400)
  @IsCorners()
  outline?: Corner[];

  /** Optional: the capacity the user gives (ITPO's "area capacity"); not worked out from the size. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  hallAreaCapacity?: number;

  /** Optional: an id from ITPO's hall categories (`T_HALLS_CATEGORY`). */
  @IsOptional()
  @IsInt()
  @Min(1)
  hallCategoryId?: number;

  /** The fields SelfCare's own create-hall form offers; all optional, false or 0 when left out. */
  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @IsOptional()
  @IsBoolean()
  isVipLounge?: boolean;

  @IsOptional()
  @IsBoolean()
  isAvailableForFnB?: boolean;

  @IsOptional()
  @IsIn([0, 1])
  complementaryDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  sortOrder?: number;

  /** Optional: pictures of the hall, by their URL. At most one is the cover. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HALL_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => HallImageDto)
  images?: HallImageDto[];
}
