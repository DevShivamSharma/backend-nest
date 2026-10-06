import { IsOptional, IsUUID, Matches } from 'class-validator';

import { PageQueryDto } from '../common/pagination';

export class AuditQueryDto extends PageQueryDto {
  @IsUUID()
  @IsOptional()
  organisationId?: string;

  /** A prefix such as `organisation.` or `invitation.created`. */
  @Matches(/^[a-z_.]{1,64}$/, { message: 'action must be an action name or prefix' })
  @IsOptional()
  action?: string;
}
