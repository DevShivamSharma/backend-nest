import type { EventType } from '../rules/rule-catalogue';
import type { RuleOverride, RuleReport, StallSide } from '../rules/rule-engine';
import type { EventStatus } from '../events/event.entity';
import type { HallFloor } from '../venues/floor/hall-floor';
import type { StallPlanStatus, StallType } from './stall-plan.entity';

export interface StallView {
  id: string;
  number: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Square metres. */
  area: number;
  openSides: StallSide[];
  stallType: StallType | null;
}

/** A hall's stall plan for an event, its floor and its rules report. */
export interface StallPlanView {
  /** Null while no plan has been saved for the hall. */
  id: string | null;
  event: { id: string; name: string; status: EventStatus; eventType: EventType };
  hall: { id: string; name: string; floorVersion: number; currentVersion: number };
  status: StallPlanStatus;
  /** 0 while no plan has been saved. */
  revision: number;
  stalls: StallView[];
  overrides: RuleOverride[];
  approvedAt: string | null;
  publishedAt: string | null;
  /** Held or confirmed bookings on its stalls. */
  activeBookings: number;
  /** The floor version the event booked, which the stalls stand on. */
  floor: HallFloor;
  report: RuleReport;
}

/** One hall of an event and its plan, for the event's overview. */
export interface EventPlanSummaryView {
  hallId: string;
  hallName: string;
  planId: string | null;
  status: StallPlanStatus | null;
  revision: number;
  stallCount: number;
  activeBookings: number;
}
