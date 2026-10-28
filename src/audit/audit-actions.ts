/** What the audit trail records, with the words the screen shows. */
export const AUDIT_ACTIONS = {
  'plan.saved': 'Plan saved',
  'plan.published': 'Plan published',
  'plan.submitted': 'Plan sent for approval',
  'plan.withdrawn': 'Plan withdrawn',
  'plan.approved': 'Plan approved',
  'plan.rejected': 'Plan rejected',
  'plan.reopened': 'Plan reopened',
  'rates.saved': 'Rates saved',
  'config.saved': 'Hall configuration saved',
  'rules.changed': 'Default rules changed',
  'rules.event_changed': 'Event rules changed',
  'rules.hall_changed': 'Hall rules changed',
  'recipients.changed': 'Email recipients changed',
  'master.deleted': 'Category or group deleted',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_KEYS = Object.keys(AUDIT_ACTIONS) as AuditAction[];
