/** Persisted switches. Missing keys keep the existing behaviour (on). */
export const BASIC_RULE_IDS = [
  'hallBoundary', 'stallOverlap', 'sizeStep', 'peripheralClearance', 'openSideAccess',
  'PASSAGE', 'NO_CONSTRUCTION', 'ENTRY_EXIT_ACCESS', 'EMERGENCY_EXIT_ACCESS',
  'FACILITY_ACCESS', 'FOYER', 'PARTITION', 'SMOKE_CURTAIN',
  // Meeting rules (October 2026): no stalls in the hall's corners, none in internal (Media/Admin)
  // zones, and B2B / B2C zones kept apart.
  'cornerKeepOut', 'internalZones', 'eventSeparation'
] as const;

export type BasicRuleId = typeof BASIC_RULE_IDS[number];
export type BasicRuleSettings = Partial<Record<BasicRuleId, boolean>>;

export function ruleEnabled(rules: { enabledRules?: BasicRuleSettings | null }, id: BasicRuleId): boolean {
  return rules.enabledRules?.[id] !== false;
}

