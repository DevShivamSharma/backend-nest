import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import { BOOKING_STATUSES, BookingStatus } from '../booking.entity';

/** A booking made by staff for a registered exhibitor: held, or confirmed at once. */
export class CreateBookingDto {
  @IsUUID()
  eventId!: string;

  /** The venue's hall, as the event's routes name it. */
  @IsUUID()
  hallId!: string;

  /** The planner's stall id, as the stall map gives it. */
  @IsUUID()
  stallId!: string;

  @IsUUID()
  exhibitorId!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class CancelBookingDto {
  /** Kept with the booking; the dialog asks for at least 3 characters too. */
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

/** Another stall of the same event, in any of its halls. */
export class MoveBookingDto {
  @IsUUID()
  hallId!: string;

  @IsUUID()
  stallId!: string;
}

export class ListBookingsQuery {
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @IsOptional()
  @IsUUID()
  exhibitorId?: string;

  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;
}