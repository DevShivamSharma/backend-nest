import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

import { NormaliseEmail, PASSWORD_MAX, PASSWORD_MIN, Trim } from '../../common/validation';

export class LoginDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, PASSWORD_MAX, { message: 'Enter your password.' })
  password!: string;
}

export class AcceptInvitationDto {
  /** Required for a new account; ignored when the account exists. */
  @Trim()
  @IsString()
  @Length(1, 120)
  @IsOptional()
  name?: string;

  /** A new account's password, or the existing account's current one. */
  @IsString()
  @Length(1, PASSWORD_MAX)
  password!: string;
}

export class ForgotPasswordDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  /** The organisation whose sign-in page was used, so the link opens in its look. */
  @IsString()
  @MaxLength(40)
  @IsOptional()
  orgSlug?: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(20, 200)
  token!: string;

  @IsString()
  @Length(PASSWORD_MIN, PASSWORD_MAX, {
    message: `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for your password.`,
  })
  password!: string;
}
