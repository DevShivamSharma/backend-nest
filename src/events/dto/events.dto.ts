import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { EmptyToNull, NormaliseEmail, Trim } from '../../common/validation';
import { EVENT_TYPES, EventType } from '../../rules/rule-catalogue';
import { EVENT_KINDS, EventKind } from '../event.entity';

/** A calendar date, `YYYY-MM-DD`; whether it exists is checked by the service. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'Dates are written as YYYY-MM-DD.';

class EventFieldsDto {
  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(80)
  venueEventId?: string | null;

  @IsOptional()
  @EmptyToNull()
  @IsString()
  @MaxLength(160)
  organiserName?: string | null;

  @IsOptional()
  @EmptyToNull()
  @Matches(DATE, { message: DATE_MESSAGE })
  buildUpOn?: string | null;

  @IsOptional()
  @EmptyToNull()
  @Matches(DATE, { message: DATE_MESSAGE })
  dismantleOn?: string | null;
}

export class CreateEventDto extends EventFieldsDto {
  @IsIn(EVENT_KINDS)
  kind!: EventKind;

  @Trim()
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsIn(EVENT_TYPES)
  audience!: EventType;

  @Matches(DATE, { message: DATE_MESSAGE })
  startsOn!: string;

  @Matches(DATE, { message: DATE_MESSAGE })
  endsOn!: string;
}

/** Changes to an event; its kind stays as created. */
export class UpdateEventDto extends EventFieldsDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @IsIn(EVENT_TYPES)
  audience?: EventType;

  @IsOptional()
  @Matches(DATE, { message: DATE_MESSAGE })
  startsOn?: string;

  @IsOptional()
  @Matches(DATE, { message: DATE_MESSAGE })
  endsOn?: string;
}

export class AddEventHallsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  hallIds!: string[];
}

export class EventHallRulesDto {
  /** Rule id -> on or off; checked against the catalogue by the service. */
  @IsObject()
  switches!: Record<string, boolean>;
}

/** Gives a person an organiser role on this event. */
export class InviteEventPersonDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @IsUUID('4')
  roleId!: string;
}
