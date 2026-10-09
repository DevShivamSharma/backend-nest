import type { EventHallDetailView } from '../events/event.views';
import type { StallSide } from '../rules/rule-engine';
import type { Point } from '../venues/floor-plan/plan.types';
import type { PlanFinding } from './plan-check';
import type { StallScheme } from './stall-plan.entity';

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

export interface StallPlanView {
  /** 0 before the first save. */
  revision: number;
  updatedAt: string | null;
  zones: PlanZoneView[];
  stalls: PlanStallView[];
  seats: PlanSeatView[];
}

/** Everything the planner opens with: the hall as the event has it, and its plan. */
export interface PlannerView {
  hall: EventHallDetailView;
  plan: StallPlanView;
  canEdit: boolean;
  /** Why the plan is read-only for this member; null when they can edit. */
  readOnlyReason: string | null;
}

export interface PlanCheckView {
  findings: PlanFinding[];
}
