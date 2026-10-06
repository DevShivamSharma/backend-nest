import { IsEmail, IsUUID, MaxLength } from 'class-validator';

import { NormaliseEmail } from '../../common/validation';

export class InviteMemberDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsUUID()
  roleId!: string;
}

export class ChangeRoleDto {
  @IsUUID()
  roleId!: string;
}
