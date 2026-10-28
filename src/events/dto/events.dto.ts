import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : trim({ value });

/** The kinds of event ITPO's internal events use. */
export const EVENT_TYPES = ['B2B', 'B2C', 'B2B & B2C both'] as const;
export type EventKind = (typeof EVENT_TYPES)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a date, YYYY-MM-DD';

/**
 * The optional fields of an internal event, shared by creating and editing one.
 * What the user gives when creating an internal event: the fields of ITPO's event booking
 * (`T_HALL_BOOKING`) that are the user's to fill. Only the name and the tenancy dates are
 * required; the rest are optional. The system sets the rest (ids, statuses, organisation).
 */
export class EventFieldsDto {
  @IsOptional()
  @IsIn(EVENT_TYPES)
  eventType?: EventKind;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(70)
  eventFormat?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  coOrganizerName?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(2000)
  productProfile?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(2000)
  specificProductProfile?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(100)
  productCategory?: string;

  /** The exhibition's own days, YYYY-MM-DD. */
  @IsOptional()
  @Matches(DATE, { message: `exhibitionStartDate ${DATE_MESSAGE}` })
  exhibitionStartDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `exhibitionEndDate ${DATE_MESSAGE}` })
  exhibitionEndDate?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(20)
  startTimeOfEvent?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(20)
  endTimeOfEvent?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  expectedNumberOfVisitor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  expectedNumberOfExhibitors?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  noOfStalls?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  noOfFnbStalls?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxCategoriesForRegistration?: number;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(2000)
  specialRequest?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(150)
  fileNumber?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(2000)
  remarks?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  bannerImageId?: number;

  @IsOptional()
  @IsBoolean()
  allowOverseasUser?: boolean;

  @IsOptional()
  @IsBoolean()
  isMarqueeEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isSecondaryEnabled?: boolean;

  /** The UI's toggle: whether the event shows in the public list. Off (false) when left out. */
  @IsOptional()
  @IsBoolean()
  visibilityStatus?: boolean;
}

export class CreateInternalEventDto extends EventFieldsDto {
  /**
   * The organisation the event is booked under, chosen by the ITPO staff member as in SelfCare
   * (an organiser from its list). It cannot be changed afterwards.
   */
  @IsUUID()
  organisationId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** First day of the event's tenancy, YYYY-MM-DD. */
  @Matches(DATE, { message: `startDate ${DATE_MESSAGE}` })
  startDate!: string;

  /** Last day of the event's tenancy, YYYY-MM-DD. */
  @Matches(DATE, { message: `endDate ${DATE_MESSAGE}` })
  endDate!: string;
}

/**
 * Editing an internal event: any of its fields, none required. An optional field sent as null is
 * cleared; the name, the dates and the flags cannot be.
 */
export class UpdateInternalEventDto extends EventFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Matches(DATE, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `endDate ${DATE_MESSAGE}` })
  endDate?: string;
}

/**
 * What the user gives for a hall of an event: the fields of ITPO's event hall (`T_EVENT_HALL`)
 * that are the user's to fill. Only the hall is required. Prices and rates are worked out when
 * booking starts, and the system sets the ids, name and approval.
 */
export class EventHallFieldsDto {
  /** An F&B hall: its F&B categories are mapped to it, as SelfCare does. */
  @IsOptional()
  @IsBoolean()
  forStallFnb?: boolean;

  /** Left out: taken from the hall itself (`T_HALLS`). */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(60)
  hallCode?: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  hallArea?: number;

  @IsOptional()
  @Matches(DATE, { message: `mountingPeriodFromDate ${DATE_MESSAGE}` })
  mountingPeriodFromDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `mountingPeriodToDate ${DATE_MESSAGE}` })
  mountingPeriodToDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `exhibitionPeriodFromDate ${DATE_MESSAGE}` })
  exhibitionPeriodFromDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `exhibitionPeriodToDate ${DATE_MESSAGE}` })
  exhibitionPeriodToDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `dismantlingPeriodFromDate ${DATE_MESSAGE}` })
  dismantlingPeriodFromDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `dismantlingPeriodToDate ${DATE_MESSAGE}` })
  dismantlingPeriodToDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  numberOfComplimentaryDay?: number;

  @IsOptional()
  @IsBoolean()
  isBookedForFnb?: boolean;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(200)
  fnbRemark?: string;

  @IsOptional()
  @IsBoolean()
  isPartialBooked?: boolean;

  @IsOptional()
  @Matches(DATE, { message: `stallBookingStartDate ${DATE_MESSAGE}` })
  stallBookingStartDate?: string;

  @IsOptional()
  @Matches(DATE, { message: `stallBookingEndDate ${DATE_MESSAGE}` })
  stallBookingEndDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  noOfStalls?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  noOfFnbStalls?: number;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  bookedArea?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  requestedArea?: number;

  @IsOptional()
  @IsBoolean()
  isNtaAreaRequest?: boolean;

  /** Only for an NTA area request; ITPO's two kinds. */
  @IsOptional()
  @IsIn(['ticketed', 'non_ticketed'])
  ntaPricingType?: string;
}

export class EventHallDto extends EventHallFieldsDto {
  @IsInt()
  @Min(1)
  hallId!: number;
}

/** Editing a hall of an event: any of its fields, none required. Optional ones sent as null are cleared. */
export class UpdateEventHallDto extends EventHallFieldsDto {}

export class AddEventHallsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EventHallDto)
  halls!: EventHallDto[];
}
