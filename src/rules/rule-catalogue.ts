/**
 * The safety and placement rules the platform can check, and the values they use. The rules
 * are code (they are checks); which rules an organisation switches on, and with which values,
 * is data, kept once per organisation.
 *
 * Rule ids are those of the first planner, so settings carried over keep their meaning. The
 * references cite ITPO's "Public Safety Measures and Design Guidelines — Third Party Events in
 * Pragati Maidan" (September 2022), section D, where a rule comes from it; another venue states
 * its own references with its rules.
 */

export const RULE_IDS = [
  'hallBoundary',
  'stallOverlap',
  'sizeStep',
  'peripheralClearance',
  'openSideAccess',
  'PASSAGE',
  'NO_CONSTRUCTION',
  'ENTRY_EXIT_ACCESS',
  'EMERGENCY_EXIT_ACCESS',
  'FACILITY_ACCESS',
  'FOYER',
  'PARTITION',
  'SMOKE_CURTAIN',
  'cornerKeepOut',
  'internalZones',
  'eventSeparation',
  'maxUtilization',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface RuleDefinition {
  id: RuleId;
  label: string;
  description: string;
  /** Where the rule comes from in ITPO's guidelines, or the meeting that agreed it. */
  reference: string;
  group: 'floor' | 'stalls' | 'access' | 'layout';
  /**
   * False when the data the rule needs does not exist yet; the rule can be switched on and
   * takes effect when it does.
   */
  available: boolean;
  /** Why it is not available yet. */
  waitingFor?: string;
}

export const RULES: readonly RuleDefinition[] = [
  {
    id: 'hallBoundary',
    label: 'Hall boundary and floor',
    description:
      'Stalls stay on the hall floor: off walls, voids, rooms, unavailable floor and the outside.',
    reference: 'Hall plan',
    group: 'floor',
    available: true,
  },
  {
    id: 'stallOverlap',
    label: 'Stall overlap',
    description: 'No stall overlaps another.',
    reference: 'Occupancy',
    group: 'stalls',
    available: true,
  },
  {
    id: 'sizeStep',
    label: 'Size step',
    description: 'Stall sizes are whole multiples of the size step.',
    reference: 'Grid',
    group: 'stalls',
    available: true,
  },
  {
    id: 'peripheralClearance',
    label: 'Wall clearance',
    description: 'A free passage of the set width along the hall’s outer walls.',
    reference: 'ITPO D5',
    group: 'floor',
    available: true,
  },
  {
    id: 'openSideAccess',
    label: 'Open-side passage',
    description:
      'The event’s passage width stays clear in front of every open side, and an open side never faces the closed side of another stall.',
    reference: 'ITPO D1',
    group: 'access',
    available: true,
  },
  {
    id: 'PASSAGE',
    label: 'Compulsory passages',
    description: 'Marked passages for entry, exit and services stay free.',
    reference: 'ITPO D2',
    group: 'access',
    available: true,
  },
  {
    id: 'NO_CONSTRUCTION',
    label: 'No-construction zones',
    description: 'Nothing is built in areas marked as no-construction.',
    reference: 'ITPO D4',
    group: 'floor',
    available: true,
  },
  {
    id: 'ENTRY_EXIT_ACCESS',
    label: 'Entry, exit and service access',
    description: 'Marked entry and exit areas stay free.',
    reference: 'ITPO D2',
    group: 'access',
    available: true,
  },
  {
    id: 'EMERGENCY_EXIT_ACCESS',
    label: 'Emergency exits',
    description: 'The set depth stays free in front of every emergency exit marked on the plan.',
    reference: 'ITPO D3',
    group: 'access',
    available: true,
  },
  {
    id: 'FACILITY_ACCESS',
    label: 'Fire-safety and facility access',
    description: 'The set clearance stays free around hose reels, panels and other services.',
    reference: 'ITPO D4',
    group: 'access',
    available: true,
  },
  {
    id: 'FOYER',
    label: 'Foyers',
    description: 'No stalls in foyers, unless the venue allows building there.',
    reference: 'ITPO D11',
    group: 'floor',
    available: true,
  },
  {
    id: 'PARTITION',
    label: 'Partition clearance',
    description: 'The set clearance stays free along collapsible partitions.',
    reference: 'ITPO D6',
    group: 'floor',
    available: false,
    waitingFor: 'Partitions marked on hall floors',
  },
  {
    id: 'SMOKE_CURTAIN',
    label: 'Fire curtains',
    description: 'Nothing is built below a fire or smoke curtain, nor within its clearance.',
    reference: 'ITPO D7',
    group: 'floor',
    available: true,
  },
  {
    id: 'cornerKeepOut',
    label: 'Hall corners',
    description:
      'At a corner of the hall, a full passage width stays clear from at least one of the two walls.',
    reference: 'Planning meeting, October 2026',
    group: 'floor',
    available: true,
  },
  {
    id: 'internalZones',
    label: 'Internal zones',
    description: 'No stalls in Media or Admin zones; they are not sold.',
    reference: 'Planning meeting, October 2026',
    group: 'layout',
    available: false,
    waitingFor: 'Zones on the layout (stall planning)',
  },
  {
    id: 'eventSeparation',
    label: 'B2B / B2C separation',
    description: 'The set distance between stalls of B2B zones and stalls of B2C zones.',
    reference: 'Planning meeting, October 2026',
    group: 'layout',
    available: false,
    waitingFor: 'Zones on the layout (stall planning)',
  },
  {
    id: 'maxUtilization',
    label: 'Floor utilisation',
    description: 'Stalls cover at most the set share of the hall’s stall floor.',
    reference: 'Planning meeting, October 2026',
    group: 'layout',
    available: true,
  },
];

export type EventType = 'B2B' | 'B2C';
export const EVENT_TYPES: readonly EventType[] = ['B2B', 'B2C'];

/** Every value the rules use, in metres unless stated. */
export interface RuleValues {
  /** Passage width in front of open sides, per kind of event. */
  passageWidth: Record<EventType, number>;
  /** Free passage along the outer walls. */
  peripheralClearance: number;
  /** Kept free around fire curtains. */
  curtainClearance: number;
  /** Kept free around services (hose reels, panels). */
  facilityClearance: number;
  /** Kept free around partitions. */
  partitionClearance: number;
  /** Free depth in front of an emergency exit. */
  emergencyExitClearance: number;
  /** Stall sizes are multiples of this. */
  sizeStep: number;
  /** Share of the stall floor that stalls may cover, 0 to 1. */
  maxUtilization: number;
  /** Between B2B and B2C zones. */
  eventSeparation: number;
  /** Stalls may stand in foyers (a foyer's constructible area). */
  foyerConstruction: boolean;
}

export const DEFAULT_RULE_VALUES: RuleValues = {
  passageWidth: { B2B: 3, B2C: 3 },
  peripheralClearance: 1,
  curtainClearance: 1,
  facilityClearance: 1,
  partitionClearance: 1,
  emergencyExitClearance: 3,
  sizeStep: 1,
  maxUtilization: 0.7,
  eventSeparation: 3,
  foyerConstruction: false,
};

export interface ValueLimit {
  key: string;
  label: string;
  unit: 'm' | 'share';
  min: number;
  max: number;
}

/** Limits on values; passages are never narrower than 1.5 m (planning meeting decision). */
export const VALUE_LIMITS: readonly ValueLimit[] = [
  { key: 'passageWidth.B2B', label: 'Passage width, B2B events', unit: 'm', min: 1.5, max: 5 },
  { key: 'passageWidth.B2C', label: 'Passage width, B2C events', unit: 'm', min: 1.5, max: 5 },
  { key: 'peripheralClearance', label: 'Wall clearance', unit: 'm', min: 0, max: 10 },
  { key: 'curtainClearance', label: 'Clearance around fire curtains', unit: 'm', min: 0, max: 10 },
  { key: 'facilityClearance', label: 'Clearance around services', unit: 'm', min: 0, max: 10 },
  { key: 'partitionClearance', label: 'Clearance along partitions', unit: 'm', min: 0, max: 10 },
  {
    key: 'emergencyExitClearance',
    label: 'Free depth at emergency exits',
    unit: 'm',
    min: 1,
    max: 20,
  },
  { key: 'sizeStep', label: 'Stall size step', unit: 'm', min: 0.1, max: 10 },
  { key: 'maxUtilization', label: 'Maximum floor utilisation', unit: 'share', min: 0.1, max: 1 },
  { key: 'eventSeparation', label: 'B2B / B2C separation', unit: 'm', min: 0, max: 20 },
];

/** Stored (partial) values over the defaults. */
export function effectiveValues(stored: Partial<RuleValues> | null | undefined): RuleValues {
  return {
    ...DEFAULT_RULE_VALUES,
    ...(stored ?? {}),
    passageWidth: { ...DEFAULT_RULE_VALUES.passageWidth, ...(stored?.passageWidth ?? {}) },
  };
}

/** Problems with a set of values, in words; empty when they are within their limits. */
export function valueProblems(values: RuleValues): string[] {
  const problems: string[] = [];
  for (const limit of VALUE_LIMITS) {
    const v = limit.key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], values);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < limit.min || v > limit.max) {
      const range =
        limit.unit === 'share'
          ? `${limit.min * 100}–${limit.max * 100}%`
          : `${limit.min}–${limit.max} m`;
      problems.push(`${limit.label} must be ${range}.`);
    }
  }
  if (typeof values.foyerConstruction !== 'boolean')
    problems.push('Say whether stalls may stand in foyers.');
  return problems;
}

/** Which rules are on: a missing switch is on. */
export type RuleSwitches = Partial<Record<RuleId, boolean>>;

export function ruleOn(switches: RuleSwitches | null | undefined, id: RuleId): boolean {
  return switches?.[id] !== false;
}
