import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

/** What code asks for: lower case words joined by dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class CreateRecipientListDto {
  @Transform(trim)
  @IsString()
  @Length(3, 60)
  @Matches(SLUG_PATTERN, {
    message: 'The slug is lower case words joined by dashes, like plan-submitted.',
  })
  slug!: string;

  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  description?: string | null;
}

export class UpdateRecipientListDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AddRecipientDto {
  @Transform(trim)
  @IsEmail({}, { message: 'That is not an email address.' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(120)
  name?: string | null;
}

export class UpdateRecipientDto {
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(120)
  name?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
