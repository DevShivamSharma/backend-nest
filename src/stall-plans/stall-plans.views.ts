import type { EventHallDetailView } from '../events/event.views';
import type { StallSide } from '../rules/rule-engine';
import type { Point } from '../venues/floor-plan/plan.types';
import type { PlanFinding } from './plan-check';
import type { PlanObjectKind, StallScheme } from './stall-plan.entity';

export interface PlanZoneView {
  id: string;
  name: string;
  color: string;
  polygon: Point[];
  /** m² */
  area: number;
}

export interface PlanStallView {
  id: string;
  zoneId: string | null;
  islandNumber: string | null;
  stallNumber: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openSides: StallSide[];
  scheme: StallScheme;
  categoryIds: string[];
  isPremium: boolean;
  isBlocked: boolean;
  isFnb: boolean;
  isBranding: boolean;
  isHorseshoe: boolean;
  isMarqueeAvailable: boolean;
  isRestrictedForOverseas: boolean;
  isActive: boolean;
  location: string | null;
  description: string | null;
}

export interface PlanSeatView {
  id: string;
  zoneId: string | null;
  rowLabel: string;
  seatNumber: number;
  x: number;
  y: number;
  width: number;
  depth: number;
  categoryId: string | null;
}

export interface PlanObjectView {
  id: string;
  kind: PlanObjectKind;
  /** Floor metres; line 2, rect 2 opposite corners, circle centre and edge, polyline 2+, text 1. */
  points: Point[];
  text: string | null;
  color: string;
}

export interface StallPlanView {
  /** 0 before the first save. */
  revision: number;
  updatedAt: string | null;
  /** The published revision; it may be older than the saved one. */
  published: { revision: number; at: string } | null;
  zones: PlanZoneView[];
  stalls: PlanStallView[];
  seats: PlanSeatView[];
  objects: PlanObjectView[];
}

/** Everything the planner opens with: the hall as the event has it, and its plan. */
export interface PlannerView {
  hall: EventHallDetailView;
  plan: StallPlanView;
  canEdit: boolean;
  /** Why the plan is read-only for this member; null when they can edit. */
  readOnlyReason: string | null;
  /** Whether this member may publish the saved plan. */
  canPublish: boolean;
}

export interface PlanCheckView {
  findings: PlanFinding[];
}
