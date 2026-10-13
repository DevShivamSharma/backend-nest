/** How a push to the venue system stands; the Task 3 delivery entity uses the same type. */
export type PlanDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';

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
