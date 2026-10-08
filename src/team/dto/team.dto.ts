import { ArrayMaxSize, IsArray, IsEmail, IsOptional, IsUUID, MaxLength } from 'class-validator';

import { EmptyToNull, NormaliseEmail } from '../../common/validation';

export class InviteMemberDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsUUID()
  roleId!: string;

  /** Event roles only: the events the person works on. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  eventIds?: string[];

  /** Event roles that book stalls only: the exhibitor the person books for. */
  @IsOptional()
  @EmptyToNull()
  @IsUUID()
  exhibitorId?: string | null;
}

export class ChangeRoleDto {
  @IsUUID()
  roleId!: string;

  /** For an event role; omitted keeps the member's current events. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  eventIds?: string[];

  @IsOptional()
  @EmptyToNull()
  @IsUUID()
  exhibitorId?: string | null;
}
