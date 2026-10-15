import type { EventHallDetailView } from '../events/event.views';
import type { StallSide } from '../rules/rule-engine';
import type { Point } from '../venues/floor-plan/plan.types';
import type { PlanFinding } from './plan-check';
import type { PlanPricingView } from './pricing/pricing.views';
import type { PlanObjectKind, PlanReviewStatus, StallScheme } from './stall-plan.entity';

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
  /** Cells cut out, [column, row] from the top-left. */
  cutCells: Array<[number, number]>;
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
  /** The venue's approval of an external event's plan; null while it was never sent. */
  review: PlanReviewView | null;
  zones: PlanZoneView[];
  stalls: PlanStallView[];
  seats: PlanSeatView[];
  objects: PlanObjectView[];
}

export interface PlanReviewView {
  status: PlanReviewStatus;
  /** The saved revision that was sent; the plan may have been saved again since an answer. */
  revision: number;
  submittedAt: string;
  submittedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  /** Why the venue sent it back. */
  note: string | null;
}

/** Everything the planner opens with: the hall as the event has it, and its plan. */
export interface PlannerView {
  hall: EventHallDetailView;
  plan: StallPlanView;
  /**
   * External events, for the venue's team who review them: the rules the saved plan breaks now
   * (none: it keeps every one). Null for everyone else, and before the first save.
   */
  findings: PlanFinding[] | null;
  /** The stalls' prices; null for members who may not see prices. */
  pricing: PlanPricingView | null;
  canEdit: boolean;
  /** Why the plan is read-only for this member; null when they can edit. */
  readOnlyReason: string | null;
  /** Whether this member may publish the saved plan (internal events). */
  canPublish: boolean;
  /** External events: the organiser's plan is published by the venue's approval. */
  needsApproval: boolean;
  /** Whether this member may send the saved plan to the venue for approval. */
  canSubmit: boolean;
  /** Whether this member may take back a plan sent for approval. */
  canWithdraw: boolean;
  /** Whether this member may approve or send back the plan waiting for approval. */
  canApprove: boolean;
}

export interface PlanCheckView {
  findings: PlanFinding[];
}
