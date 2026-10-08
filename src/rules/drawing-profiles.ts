import type { PlanStall, Violation } from './rule-engine';

/**
 * What a venue's own system can take from a layout. Checked before publishing: a layout that
 * the venue's system cannot store faithfully is stopped here, not mangled there.
 */
export interface DrawingProfile {
  id: string;
  label: string;
  description: string;
  /** Stall positions and sizes lie on a grid of this many metres (null: anywhere). */
  gridMetres: number | null;
  /** Stalls may not be turned. */
  noRotation: boolean;
  /** Largest stall side the system stores, metres (null: no limit). */
  maxSide: number | null;
}

export const DRAWING_PROFILES: readonly DrawingProfile[] = [
  {
    id: 'free',
    label: 'No constraints',
    description: 'Any position, size and angle.',
    gridMetres: null,
    noRotation: false,
    maxSide: null,
  },
  {
    id: 'grid',
    label: '1 m grid',
    description: 'Whole-metre positions and sizes, straight edges, never turned.',
    gridMetres: 1,
    noRotation: true,
    maxSide: null,
  },
];

export function drawingProfile(id: string | null | undefined): DrawingProfile | null {
  return DRAWING_PROFILES.find((p) => p.id === id) ?? null;
}

const EPS = 1e-6;

export function profileViolations(profile: DrawingProfile, stalls: PlanStall[]): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, message: string, s: PlanStall) =>
    out.push({
      ruleId: `profile.${rule}`,
      reference: profile.label,
      message,
      stallIds: [s.id],
      areas: [{ x: s.x, y: s.y, width: s.width, height: s.depth }],
      overridden: null,
    });
  const label = (s: PlanStall) => (s.number ? `Stall ${s.number}` : 'A stall');
  for (const s of stalls) {
    if (profile.noRotation && (s.rotation ?? 0) % 360 !== 0) {
      add('rotation', `${label(s)} is turned; stalls must run along the grid.`, s);
    }
    if (profile.gridMetres) {
      const g = profile.gridMetres;
      const on = (v: number) => Math.abs(v / g - Math.round(v / g)) < EPS;
      if (![s.x, s.y, s.width, s.depth].every(on)) {
        add('grid', `${label(s)} is off the ${g} m grid: positions and sizes in whole cells.`, s);
      }
    }
    if (profile.maxSide && Math.max(s.width, s.depth) > profile.maxSide + EPS) {
      add('size', `${label(s)} is longer than ${profile.maxSide} m, the longest side allowed.`, s);
    }
  }
  return out;
}
