import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { AUDIT_ACTION_KEYS } from '../audit-actions';

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class AuditQueryDto {
  @IsOptional()
  @IsIn(AUDIT_ACTION_KEYS)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  event?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  user?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Dates are written YYYY-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Dates are written YYYY-MM-DD.' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}
