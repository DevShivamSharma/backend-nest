import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';

/** A hold the exhibitor's own user asks for; the exhibitor comes from their access, not from here. */
export class PortalHoldDto {
  @IsUUID()
  eventId!: string;

  /** The venue's hall, as the event's routes name it. */
  @IsUUID()
  hallId!: string;

  /** The planner's stall id, as the stall map gives it. */
  @IsUUID()
  stallId!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class PortalCancelDto {
  /** Kept with the booking; optional, an exhibitor letting go need not explain. */
  @IsOptional()
  @EmptyToNull()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
