import { BadRequestDomainError } from '../../common/errors/domain.errors';
import type { HallMarker } from '../entities/hall.entity';
import {
  DEFAULT_LAYOUT_RULES,
  effectiveRules,
  EVENT_TYPES,
  EventType,
  HallOpening,
  HallZone,
  LayoutRules,
  OPENING_FACINGS,
  OPENING_KINDS,
  PlacementContext,
  PlacementStall,
  Point,
  STALL_STATUSES,
  StallStatus,
  ZONE_KINDS,
} from './placement-rules';

/**
 * Structural checks for the rule-driven hall fields (BR-22) and the helpers that turn stored
 * data into a PlacementContext. The pipe only guarantees "is an array / is an object"; the
 * contents are checked here, with messages that name the broken entry.
 *
 * Every field is optional. A hall with none of them behaves exactly as before.
 */

export interface HallGeometryInput {
  boundary?: unknown[] | null;
  zones?: unknown[] | null;
  openings?: unknown[] | null;
  markers?: unknown[] | null;
  rules?: Record<string, unknown> | null;
}

export interface HallGeometry {
  boundary: Point[] | null;
  zones: HallZone[] | null;
  openings: HallOpening[] | null;
  markers: HallMarker[] | null;
  rules: Partial<LayoutRules> | null;
}

/** BR-22. Throws on the first malformed entry; returns the cleaned values to store. */
export function validateHallGeometry(input: HallGeometryInput): HallGeometry {
  return {
    boundary: input.boundary == null ? null : polygon(input.boundary, 'Hall boundary'),
    zones: input.zones == null ? null : input.zones.map((z, i) => zone(z, i)),
    openings: input.openings == null ? null : input.openings.map((o, i) => opening(o, i)),
    markers: input.markers == null ? null : input.markers.map((m, i) => marker(m, i)),
    rules: input.rules == null ? null : rules(input.rules),
  };
}

/** The rule-driven hall fields as they go on the wire (null when absent). */
export function hallGeometryResponse(hall: {
  boundary?: unknown[] | null;
  zones?: unknown[] | null;
  openings?: unknown[] | null;
  markers?: unknown[] | null;
  rules?: object | null;
}): {
  boundary: unknown[] | null;
  zones: unknown[] | null;
  openings: unknown[] | null;
  markers: unknown[] | null;
  rules: Record<string, unknown> | null;
} {
  return {
    boundary: hall.boundary ?? null,
    zones: hall.zones ?? null,
    openings: hall.openings ?? null,
    markers: hall.markers ?? null,
    rules: (hall.rules as Record<string, unknown> | null | undefined) ?? null,
  };
}

/** BR-23. Blank means AVAILABLE. */
export function normalizeStatus(value: string | null | undefined): StallStatus {
  const status = value == null || value.trim() === '' ? 'AVAILABLE' : value.trim().toUpperCase();

  if (!(STALL_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestDomainError('status must be AVAILABLE, BOOKED or CANCELLED.');
  }

  return status as StallStatus;
}

export function normalizeEventType(value: string | null | undefined): EventType {
  const type = value == null || value.trim() === '' ? 'B2B' : value.trim().toUpperCase();

  if (!(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new BadRequestDomainError('eventType must be B2B or B2C.');
  }

  return type as EventType;
}

export { effectiveRules };

/** A hall is rule-driven when it carries a `rules` object. */
export function isRuleDriven(hall: { rules?: Partial<LayoutRules> | null }): boolean {
  return hall.rules != null;
}

export function buildPlacementContext(
  hall: {
    boundary?: Point[] | null;
    zones?: HallZone[] | null;
    openings?: HallOpening[] | null;
    rules?: Partial<LayoutRules> | null;
  },
  eventType: EventType,
  stalls: PlacementStall[],
): PlacementContext {
  return {
    boundary: hall.boundary ?? null,
    zones: hall.zones ?? [],
    openings: hall.openings ?? [],
    rules: effectiveRules(hall.rules),
    eventType,
    stalls,
  };
}

// --- entry checks ------------------------------------------------------------------------------

function polygon(raw: unknown, what: string): Point[] {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new BadRequestDomainError(`${what} must be a polygon of at least 3 points.`);
  }

  return raw.map((p) => {
    const point = p as { x?: unknown; z?: unknown } | null;
    if (!point || !finite(point.x) || !finite(point.z)) {
      throw new BadRequestDomainError(`${what} points must have numeric x and z.`);
    }
    return { x: point.x as number, z: point.z as number };
  });
}

function zone(raw: unknown, index: number): HallZone {
  const z = (raw ?? {}) as Record<string, unknown>;
  const what = `Zone ${index}`;

  if (typeof z['id'] !== 'string' || z['id'].trim() === '') {
    throw new BadRequestDomainError(`${what} needs an id.`);
  }
  if (!(ZONE_KINDS as readonly unknown[]).includes(z['kind'])) {
    throw new BadRequestDomainError(`${what} has an unknown kind. Use one of ${ZONE_KINDS.join(', ')}.`);
  }
  if (z['clearance'] != null && (!finite(z['clearance']) || (z['clearance'] as number) < 0)) {
    throw new BadRequestDomainError(`${what} clearance must be a non-negative number of metres.`);
  }

  return {
    id: z['id'],
    kind: z['kind'] as HallZone['kind'],
    label: typeof z['label'] === 'string' && z['label'].trim() !== '' ? z['label'] : (z['kind'] as string),
    polygon: polygon(z['polygon'], `${what} polygon`),
    ...(z['clearance'] != null ? { clearance: z['clearance'] as number } : {}),
    ...(typeof z['color'] === 'string' ? { color: z['color'] } : {}),
  };
}

function opening(raw: unknown, index: number): HallOpening {
  const o = (raw ?? {}) as Record<string, unknown>;
  const what = `Opening ${index}`;
  const position = (o['position'] ?? {}) as { x?: unknown; z?: unknown };

  if (typeof o['id'] !== 'string' || o['id'].trim() === '') {
    throw new BadRequestDomainError(`${what} needs an id.`);
  }
  if (!(OPENING_KINDS as readonly unknown[]).includes(o['kind'])) {
    throw new BadRequestDomainError(`${what} kind must be ${OPENING_KINDS.join(', ')}.`);
  }
  if (!(OPENING_FACINGS as readonly unknown[]).includes(o['facing'])) {
    throw new BadRequestDomainError(`${what} facing must be ${OPENING_FACINGS.join(', ')}.`);
  }
  if (!finite(position.x) || !finite(position.z)) {
    throw new BadRequestDomainError(`${what} needs a position with numeric x and z.`);
  }
  if (!finite(o['width']) || (o['width'] as number) <= 0) {
    throw new BadRequestDomainError(`${what} width must be greater than 0.`);
  }

  return {
    id: o['id'],
    label: typeof o['label'] === 'string' ? o['label'] : o['id'],
    kind: o['kind'] as HallOpening['kind'],
    facing: o['facing'] as HallOpening['facing'],
    position: { x: position.x as number, z: position.z as number },
    width: o['width'] as number,
  };
}

function marker(raw: unknown, index: number): HallMarker {
  const m = (raw ?? {}) as { text?: unknown; position?: { x?: unknown; z?: unknown } };

  if (typeof m.text !== 'string' || !finite(m.position?.x) || !finite(m.position?.z)) {
    throw new BadRequestDomainError(`Marker ${index} needs text and a position with numeric x and z.`);
  }

  return { text: m.text, position: { x: m.position!.x as number, z: m.position!.z as number } };
}

function rules(raw: Record<string, unknown>): Partial<LayoutRules> {
  const out: Partial<LayoutRules> = {};
  const metres = (key: string, value: unknown, allowZero: boolean): number => {
    if (!finite(value) || (value as number) < 0 || (!allowZero && (value as number) === 0)) {
      throw new BadRequestDomainError(`Hall rules: ${key} must be a ${allowZero ? 'non-negative' : 'positive'} number of metres.`);
    }
    return value as number;
  };

  if (raw['minPassageWidth'] != null) {
    const mp = raw['minPassageWidth'] as Record<string, unknown>;
    out.minPassageWidth = {
      B2B: metres('minPassageWidth.B2B', mp['B2B'] ?? DEFAULT_LAYOUT_RULES.minPassageWidth.B2B, false),
      B2C: metres('minPassageWidth.B2C', mp['B2C'] ?? DEFAULT_LAYOUT_RULES.minPassageWidth.B2C, false),
    };
  }
  if (raw['peripheralClearance'] != null) {
    out.peripheralClearance = metres('peripheralClearance', raw['peripheralClearance'], true);
  }
  if (raw['zoneClearance'] != null) {
    const zc = raw['zoneClearance'] as Record<string, unknown>;
    out.zoneClearance = {};
    for (const [kind, value] of Object.entries(zc)) {
      if (!(ZONE_KINDS as readonly string[]).includes(kind)) {
        throw new BadRequestDomainError(`Hall rules: zoneClearance has an unknown zone kind ${kind}.`);
      }
      out.zoneClearance[kind as HallZone['kind']] = metres(`zoneClearance.${kind}`, value, true);
    }
  }
  if (raw['openingAccessDepth'] != null) {
    out.openingAccessDepth = metres('openingAccessDepth', raw['openingAccessDepth'], false);
  }
  if (raw['gridUnit'] != null) out.gridUnit = metres('gridUnit', raw['gridUnit'], false);
  if (raw['snapStep'] != null) out.snapStep = metres('snapStep', raw['snapStep'], false);
  if (raw['stallNumberPrefix'] != null) {
    if (typeof raw['stallNumberPrefix'] !== 'string' || raw['stallNumberPrefix'].length > 20) {
      throw new BadRequestDomainError('Hall rules: stallNumberPrefix must be text of at most 20 characters.');
    }
    out.stallNumberPrefix = raw['stallNumberPrefix'];
  }

  return out;
}

function finite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}
