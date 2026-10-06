import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { ALL_PERMISSIONS, Permission } from '../permissions';
import { RoleScopeKind } from '../role.entity';

export class CreateRoleDto {
  /** Leave out for a role every organisation can use. */
  @IsUUID()
  @IsOptional()
  organisationId?: string;

  @Matches(/^[a-z][a-z0-9_]{1,47}$/, {
    message: 'key must be 2–48 lower-case letters, digits or _, starting with a letter',
  })
  key!: string;

  @Trim()
  @IsString()
  @Length(2, 80)
  name!: string;

  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  description?: string | null;

  @IsEnum(RoleScopeKind)
  scopeKind!: RoleScopeKind;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true, message: 'permissions has an unknown permission' })
  permissions!: Permission[];
}

export class UpdateRoleDto {
  @Trim()
  @IsString()
  @Length(2, 80)
  @IsOptional()
  name?: string;

  @EmptyToNull()
  @IsString()
  @MaxLength(300)
  @IsOptional()
  description?: string | null;

  /** Only while no member or invitation uses the role. */
  @IsEnum(RoleScopeKind)
  @IsOptional()
  scopeKind?: RoleScopeKind;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true, message: 'permissions has an unknown permission' })
  @IsOptional()
  permissions?: Permission[];
}

export class RoleListQueryDto {
  /** Platform roles plus this organisation's own; leave out for every role. */
  @IsUUID()
  @IsOptional()
  organisationId?: string;
}
