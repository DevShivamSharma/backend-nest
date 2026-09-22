/**
 * Stall types offered by the layout editor.
 *
 * `width` runs along the hall's X axis and `height` is the plan depth (the planner's stall
 * `length`, along Z) — named as in the problem statement. Units are metres. The editor rotates
 * a type by 90° when the user drags vertically, so 3 x 2 also covers 2 x 3.
 *
 * Configuration only: adding a size here needs no frontend or rendering change.
 */
export interface StallType {
  id: string;
  label: string;
  width: number;
  height: number;
  unit: 'meter';
}

export const STALL_TYPES: readonly StallType[] = [
  { id: 'stall-3x2', label: '3 × 2', width: 3, height: 2, unit: 'meter' },
  { id: 'stall-4x2', label: '4 × 2', width: 4, height: 2, unit: 'meter' },
  { id: 'stall-10x10', label: '10 × 10', width: 10, height: 10, unit: 'meter' },
];
