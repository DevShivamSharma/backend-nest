import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, HEX_COLOR, IMAGE_URL } from '../../common/validation';
import { FONT_FAMILIES, FontFamily, Language, LANGUAGES } from '../organisation-config';

/** GSTIN: state code, PAN, entity number, `Z`, checksum. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export class BrandingDto {
  @Matches(HEX_COLOR, { message: 'primaryColor must be a colour like #1f5fbf' })
  primaryColor!: string;

  @EmptyToNull()
  @Matches(HEX_COLOR, { message: 'accentColor must be a colour like #e07a1f' })
  @IsOptional()
  accentColor?: string | null;

  @IsIn(FONT_FAMILIES)
  fontFamily!: FontFamily;

  @EmptyToNull()
  @MaxLength(2048)
  @Matches(IMAGE_URL, { message: 'logoUrl must be an https:// address or a /path on this site' })
  @IsOptional()
  logoUrl?: string | null;

  @EmptyToNull()
  @MaxLength(2048)
  @Matches(IMAGE_URL, {
    message: 'logoDarkUrl must be an https:// address or a /path on this site',
  })
  @IsOptional()
  logoDarkUrl?: string | null;

  @EmptyToNull()
  @MaxLength(2048)
  @Matches(IMAGE_URL, { message: 'faviconUrl must be an https:// address or a /path on this site' })
  @IsOptional()
  faviconUrl?: string | null;
}

export class LocaleDto {
  @IsIn(LANGUAGES)
  defaultLanguage!: Language;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(LANGUAGES.length)
  @IsIn(LANGUAGES, { each: true })
  languages!: Language[];

  @IsISO4217CurrencyCode()
  currency!: string;

  @IsTimeZone()
  timezone!: string;
}

export class LegalDto {
  @EmptyToNull()
  @IsString()
  @MaxLength(200)
  @IsOptional()
  legalName?: string | null;

  @EmptyToNull()
  @Matches(GSTIN, { message: 'gstin must be a 15-character GSTIN' })
  @IsOptional()
  gstin?: string | null;

  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  address?: string | null;

  @EmptyToNull()
  @Matches(/^[A-Z0-9/-]{1,12}$/, {
    message: 'invoicePrefix must be up to 12 capital letters, digits, / or -',
  })
  @IsOptional()
  invoicePrefix?: string | null;

  @EmptyToNull()
  @IsEmail()
  @MaxLength(254)
  @IsOptional()
  supportEmail?: string | null;
}

export class EmailSettingsDto {
  @EmptyToNull()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  senderName?: string | null;

  @EmptyToNull()
  @IsEmail()
  @MaxLength(254)
  @IsOptional()
  replyTo?: string | null;

  @EmptyToNull()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  footer?: string | null;
}

/** The whole configuration; a save replaces it and becomes the next version. */
export class OrganisationConfigDto {
  @ValidateNested()
  @Type(() => BrandingDto)
  branding!: BrandingDto;

  @ValidateNested()
  @Type(() => LocaleDto)
  locale!: LocaleDto;

  @ValidateNested()
  @Type(() => LegalDto)
  legal!: LegalDto;

  @ValidateNested()
  @Type(() => EmailSettingsDto)
  email!: EmailSettingsDto;
}
