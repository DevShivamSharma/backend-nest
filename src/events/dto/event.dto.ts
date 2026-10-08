import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { EmptyToNull, NormaliseEmail, Trim } from '../../common/validation';
import { EVENT_TYPES, EventType } from '../../rules/rule-catalogue';
import { EVENT_KINDS, EVENT_STATUSES, EventKind, EventStatus } from '../event.entity';

/** A calendar day, `YYYY-MM-DD`. */
export const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MESSAGE = 'must be a date written YYYY-MM-DD';

export class CreateEventDto {
  @IsUUID()
  venueId!: string;

  @Trim()
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsIn(EVENT_KINDS)
  kind!: EventKind;

  @IsIn(EVENT_TYPES)
  eventType!: EventType;

  @Matches(DAY, { message: `startsOn ${DAY_MESSAGE}` })
  startsOn!: string;

  @Matches(DAY, { message: `endsOn ${DAY_MESSAGE}` })
  endsOn!: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(160)
  organiserName?: string | null;

  @IsOptional()
  @EmptyToNull()
  @NormaliseEmail()
  @IsEmail({}, { message: 'organiserEmail must be a valid email address' })
  @MaxLength(254)
  organiserEmail?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(32)
  organiserPhone?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

/** Every field optional; the venue can change only while the event books no hall. */
export class UpdateEventDto {
  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(40)
  code?: string | null;

  @IsOptional()
  @IsIn(EVENT_KINDS)
  kind?: EventKind;

  @IsOptional()
  @IsIn(EVENT_TYPES)
  eventType?: EventType;

  @IsOptional()
  @Matches(DAY, { message: `startsOn ${DAY_MESSAGE}` })
  startsOn?: string;

  @IsOptional()
  @Matches(DAY, { message: `endsOn ${DAY_MESSAGE}` })
  endsOn?: string;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(160)
  organiserName?: string | null;

  @IsOptional()
  @EmptyToNull()
  @NormaliseEmail()
  @IsEmail({}, { message: 'organiserEmail must be a valid email address' })
  @MaxLength(254)
  organiserEmail?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(32)
  organiserPhone?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class ChangeEventStatusDto {
  @IsIn(EVENT_STATUSES)
  status!: EventStatus;

  /** Why an event is cancelled; kept with it. */
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class ListEventsQuery {
  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: EventStatus;

  @IsOptional()
  @IsUUID()
  venueId?: string;
}
