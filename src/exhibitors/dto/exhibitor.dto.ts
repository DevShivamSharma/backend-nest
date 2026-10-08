import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

import { EmptyToNull, NormaliseEmail, Trim } from '../../common/validation';

/** GSTIN: state code, PAN, entity number, `Z`, checksum (as the organisation settings check it). */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class CreateExhibitorDto {
  @Trim()
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @IsOptional()
  @EmptyToNull()
  @NormaliseEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @EmptyToNull()
  @Matches(GSTIN, { message: 'gstin must be a 15-character GSTIN' })
  gstin?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  /** Registers the new exhibitor for this event at once; required of event-scoped members. */
  @IsOptional()
  @IsUUID()
  eventId?: string;
}

export class UpdateExhibitorDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @IsOptional()
  @EmptyToNull()
  @NormaliseEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @EmptyToNull()
  @Matches(GSTIN, { message: 'gstin must be a 15-character GSTIN' })
  gstin?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  address?: string | null;
}

export class ListExhibitorsQuery {
  @IsOptional()
  @IsUUID()
  eventId?: string;
}
