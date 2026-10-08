import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyToNull, Trim } from '../../common/validation';
import type { BookingStatus } from '../booking.entity';
import {
  VENUE_BOOKING_STATUSES,
  VENUE_PAYMENT_STATUSES,
  VenueBookingStatus,
  VenuePaymentStatus,
} from '../booking-rules';

const BOOKING_STATUSES: readonly BookingStatus[] = ['held', 'confirmed', 'cancelled', 'expired'];

/** A booking made by staff for a registered exhibitor: held, or confirmed at once. */
export class CreateBookingDto {
  @IsUUID()
  eventId!: string;

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
  @Trim()
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class MoveBookingDto {
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

/** An exhibitor's own hold, through the portal; the exhibitor comes from its membership. */
export class PortalBookingDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  stallId!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class PortalCancelDto {
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

/**
 * A status report from the venue's booking system (proposed contract, see docs/14): which of
 * our bookings, and SelfCare's words for its state and its payment's.
 */
export class VenueStatusDto {
  /** The sender's id for this report; a second report with the same id does nothing. */
  @IsString()
  @Matches(/^[\w.:-]{1,100}$/, { message: 'deliveryId must be 1–100 letters, digits or ._:-' })
  deliveryId!: string;

  @IsUUID()
  bookingId!: string;

  @IsIn(VENUE_BOOKING_STATUSES)
  bookingStatus!: VenueBookingStatus;

  @IsIn(VENUE_PAYMENT_STATUSES)
  paymentStatus!: VenuePaymentStatus;

  /** The venue system's own reference for the booking, e.g. SelfCare's booking code. */
  @IsOptional()
  @IsString()
  @Matches(/^[\w./:-]{1,80}$/, { message: 'externalRef must be 1–80 letters, digits or ./:-' })
  externalRef?: string;
}

// ---- SelfCare row export (ported from the planner on `main`, same names as SelfCare's columns)

export class SelfcarePricingDto {
  @IsOptional() @IsNumber() @Min(0) bare_rate!: number | null;
  @IsOptional() @IsNumber() @Min(0) shell_rate!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) two_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) three_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) four_side_open_rate_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) catlog_entry_charge!: number | null;
  @IsBoolean() corner_charges_applicable!: boolean;
}

export class SelfcareTaxDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) cgst_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) sgst_percent!: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) igst_percent!: number | null;
}

/**
 * SelfCare's own ids and its price-master values for the stall, all optional: without prices
 * every amount stays null. Nothing here is stored.
 */
export class SelfcareRowDto {
  @IsOptional() @IsUUID() user_id?: string | null;
  @IsOptional() @IsUUID() event_id?: string | null;
  @IsOptional() @IsUUID() event_hall_id?: string | null;
  @IsOptional() @IsInt() @Min(1) hall_id?: number | null;
  @IsOptional() @IsUUID() stall_id?: string | null;
  @IsOptional() @IsInt() @Min(1) product_category_id?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SelfcarePricingDto)
  pricing?: SelfcarePricingDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => SelfcareTaxDto)
  tax?: SelfcareTaxDto | null;
}
