import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { PageQueryDto } from '../../common/pagination';
import { HEX_COLOR, NormaliseEmail, Trim } from '../../common/validation';
import { FeaturesDto, LimitsDto } from '../../organisations/dto/platform-settings.dto';
import { BookingMode } from '../../organisations/organisation-config';
import { OrganisationStatus } from '../../organisations/organisation.entity';

export class FirstAdminDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'firstAdmin.email must be a valid email address' })
  @MaxLength(254)
  email!: string;
}

export class CreateOrganisationDto {
  @Trim()
  @IsString()
  @Length(2, 160)
  name!: string;

  /** Checked in full (pattern, reserved words, taken) by the service. */
  @Trim()
  @IsString()
  @Length(3, 40)
  slug!: string;

  @IsEnum(BookingMode)
  @IsOptional()
  bookingMode?: BookingMode;

  @ValidateNested()
  @Type(() => FeaturesDto)
  @IsOptional()
  features?: FeaturesDto;

  @ValidateNested()
  @Type(() => LimitsDto)
  @IsOptional()
  limits?: LimitsDto;

  @Matches(HEX_COLOR, { message: 'primaryColor must be a colour like #1f5fbf' })
  @IsOptional()
  primaryColor?: string;

  /** The first Venue Admin, invited by email as the organisation is created. */
  @ValidateNested()
  @Type(() => FirstAdminDto)
  firstAdmin!: FirstAdminDto;
}

export class UpdateOrganisationDto {
  @Trim()
  @IsString()
  @Length(2, 160)
  @IsOptional()
  name?: string;

  @IsEnum(BookingMode)
  @IsOptional()
  bookingMode?: BookingMode;

  @ValidateNested()
  @Type(() => FeaturesDto)
  @IsOptional()
  features?: FeaturesDto;

  @ValidateNested()
  @Type(() => LimitsDto)
  @IsOptional()
  limits?: LimitsDto;
}

export class ChangeSlugDto {
  @Trim()
  @IsString()
  @Length(3, 40)
  slug!: string;
}

export class SuspendDto {
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class AdminInviteDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  /** Defaults to the owner role (Venue Admin). */
  @IsUUID()
  @IsOptional()
  roleId?: string;
}

export class OrganisationListQueryDto extends PageQueryDto {
  @Trim()
  @IsString()
  @MaxLength(100)
  @IsOptional()
  q?: string;

  @IsIn(Object.values(OrganisationStatus))
  @IsOptional()
  status?: OrganisationStatus;

  @IsIn(['name', 'newest'])
  @IsOptional()
  sort?: 'name' | 'newest';
}

export class SlugCheckQueryDto {
  @Trim()
  @IsString()
  @MaxLength(60)
  slug!: string;

  /** The organisation being renamed, which may keep or take back its own slugs. */
  @IsUUID()
  @IsOptional()
  organisationId?: string;
}
