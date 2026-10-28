import type { EventKind } from '../services/plan-context.service';

export type PlanReviewStatus = 'submitted' | 'approved' | 'rejected';

export interface PlanAccessInput {
  kind: EventKind;
  /** ITPO's approval of the event. */
  approvalStatus: string | null;
  cancelled: boolean;
  /** An organiser of the event's organisation, rather than ITPO staff. */
  organiser: boolean;
  revision: number;
  review: { status: PlanReviewStatus; revision: number } | null;
  publishedRevision: number | null;
}

export interface PlanAccess {
  canEdit: boolean;
  /** Why the plan is read-only for this user; null when they can edit. */
  readOnlyReason: string | null;
  canPublish: boolean;
  /** External events: the plan is published only after ITPO approves it. */
  needsApproval: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  /** ITPO staff may take an approved hall back to Draft. */
  canReopen: boolean;
}

/**
 * Who may do what with an event hall's plan.
 *  - An internal event is planned and published by ITPO staff.
 *  - An external event is planned by its organiser, once ITPO has approved the event. The organiser
 *    sends the saved plan to ITPO; ITPO staff approve it or send it back; once that revision is
 *    approved, the organiser publishes it. While it waits, it cannot change.
 */
export function planAccess(input: PlanAccessInput): PlanAccess {
  const { kind, organiser, review, revision } = input;
  const external = kind === 'external';
  const waiting = external && review?.status === 'submitted';
  const approvedHere = external && review?.status === 'approved' && review.revision === revision;
  const published = input.publishedRevision === revision && revision > 0;

  const reason = drawingProblem(input);
  const canDraw = reason === null;
  const readOnlyReason = reason ?? (waiting && organiser ? WAITING : null);

  return {
    canEdit: readOnlyReason === null,
    readOnlyReason,
    canPublish: canDraw && !published && (external ? approvedHere : revision > 0),
    needsApproval: external,
    canSubmit: canDraw && external && !waiting && revision > 0 && !approvedHere && !published,
    canWithdraw: canDraw && waiting,
    canApprove: external && !organiser && waiting && !input.cancelled,
    canReopen: external && !organiser && approvedHere && !input.cancelled,
  };
}

const WAITING =
  'The plan was sent to ITPO for approval. It can change again once they answer, or after you withdraw it.';

/** Null when this user may draw on the event's halls; else why not, in words. */
function drawingProblem(input: PlanAccessInput): string | null {
  if (input.cancelled) return 'This event or hall is cancelled, so its plan cannot change.';
  if (input.kind === 'internal') {
    return input.organiser ? 'ITPO’s own team plans the stalls of internal events.' : null;
  }
  if (!input.organiser) return 'The organiser plans the stalls of this external event.';
  if (input.approvalStatus !== 'Approved') {
    return 'Stalls can be planned once ITPO approves the event.';
  }
  return null;
}
