import type { PlanDeliveryStatus } from './plan-delivery.entity';

export type { PlanDeliveryStatus };

/** The link as people see it: never the secret, only its last four characters. */
export interface VenueIntegrationView {
  configured: boolean;
  callbackUrl: string | null;
  secretHint: string | null;
  enabled: boolean;
  updatedAt: string | null;
  /** The organisation's most recent push, for "is it working?". */
  lastDelivery: {
    status: PlanDeliveryStatus;
    at: string;
    event: string;
    hall: string;
    error: string | null;
  } | null;
}

/** One push of a hall's published plan to the venue system. */
export interface PlanDeliveryView {
  id: string;
  revision: number;
  status: PlanDeliveryStatus;
  attempts: number;
  /** Next try while pending; the lease end while sending. */
  nextAttemptAt: string | null;
  /** Null on a delivered row: the log transport sent nothing. */
  lastStatusCode: number | null;
  venueCode: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  resentFromId: string | null;
}

/** The pushes of one event hall's plan, for the planner. */
export interface PlanDeliveriesView {
  /** Internal event that sells through the venue system: its publishes are pushed. */
  pushes: boolean;
  /** Why nothing is pushed although `pushes`: no link, or the link is off. */
  reason: string | null;
  canResend: boolean;
  /** Newest first, at most 20. */
  deliveries: PlanDeliveryView[];
}
