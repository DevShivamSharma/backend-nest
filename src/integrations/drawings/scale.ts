/**
 * How many metres one map unit (a grid cell, or a block of pixels without a grid) is, and how
 * that is known. Every value here comes from the plan or from the person importing; when
 * neither says, the scale is unknown and the import says so instead of assuming.
 */

export type ScaleSource = 'stated-grid' | 'dimensions' | 'file' | 'calibration';

export interface ScaleCandidate {
  source: ScaleSource;
  metresPerUnit: number;
  /** What it rests on, for the review screen. */
  detail: string;
}

export interface ScaleDecision {
  /** Null when unknown. */
  metresPerUnit: number | null;
  /**
   * verified: two independent sources agree; single: one source, nothing to cross-check;
   * calibrated: the person set it; conflict: sources disagree; unknown: no source.
   */
  status: 'verified' | 'single' | 'calibrated' | 'conflict' | 'unknown';
  candidates: ScaleCandidate[];
  note: string;
}

/** Two scales within this share of each other agree. */
export const SCALE_AGREEMENT = 0.02;

/** A dimension line, measured in map units. */
export interface MeasuredDimension {
  text: string;
  value: number;
  unit: 'm' | 'mm' | 'cm' | 'ft' | null;
  /** Its length in map units. */
  units: number;
}

const UNIT_METRES: Record<'m' | 'mm' | 'cm' | 'ft', number> = {
  m: 1,
  mm: 0.001,
  cm: 0.01,
  ft: 0.3048,
};
/** Grid sizes drafters use, in metres: a reading close to one is likelier. */
const NICE_GRIDS = [0.5, 1, 1.2, 1.5, 2, 2.4, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * "NOTE: Grid size is 1m x 1m", "GRID 3M X 3M", "Grid: 1000 x 1000 mm". OCR confuses 1 with
 * l, I, T and |, and 0 with O, inside such a phrase; those are read as digits there.
 */
export function statedGridSize(texts: string[]): { metres: number; text: string } | null {
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ');
    const m =
      /grid\s*(?:size)?\s*(?:is|=|:|of|-|\S{1,3}(?=\s))?\s*([0-9TIl|O.,]{1,6})\s*(m|mm|cm|mtrs?|ft|'|m)?\s*[x×*]\s*([0-9TIl|O.,]{1,6})\s*(m|mm|cm|mtrs?|ft|')/i.exec(
        text,
      );
    if (!m) continue;
    const digits = (v: string) =>
      Number(
        v
          .replace(/[TIl|]/g, '1')
          .replace(/O/g, '0')
          .replace(',', '.'),
      );
    const a = digits(m[1]);
    const b = digits(m[3]);
    if (!(a > 0) || Math.abs(a - b) > 1e-9) continue;
    const unitWord = (m[4] ?? m[2] ?? 'm').toLowerCase();
    const unit =
      unitWord === 'mm' ? 'mm' : unitWord === 'cm' ? 'cm' : /ft|'/.test(unitWord) ? 'ft' : 'm';
    const metres = a * UNIT_METRES[unit];
    if (metres >= 0.1 && metres <= 50) return { metres, text: raw.trim() };
  }
  return null;
}

/**
 * The scale the dimension lines agree on. Each line states a length; measured on the map it
 * gives metres per unit, once its unit is known (metres unless printed otherwise, but CAD
 * plans often print millimetres). The reading most lines agree on wins; for a gridded plan, a
 * reading that makes the grid a size drafters use counts as a tie-breaker only.
 */
export function dimensionScale(
  dimensions: MeasuredDimension[],
  gridded: boolean,
): (ScaleCandidate & { agreeing: MeasuredDimension[] }) | null {
  const readings: Array<{ mpu: number; d: MeasuredDimension }> = [];
  for (const d of dimensions) {
    if (!(d.units > 0)) continue;
    const units = d.unit ? [d.unit] : (['m', 'mm'] as const);
    for (const unit of units) readings.push({ mpu: (d.value * UNIT_METRES[unit]) / d.units, d });
  }
  let best: { mpu: number; agreeing: MeasuredDimension[]; nice: boolean } | null = null;
  for (const r of readings) {
    const agreeing = new Set<MeasuredDimension>();
    let sum = 0;
    for (const o of readings) {
      if (agreeing.has(o.d)) continue;
      if (Math.abs(o.mpu - r.mpu) <= SCALE_AGREEMENT * r.mpu) {
        agreeing.add(o.d);
        sum += o.mpu;
      }
    }
    const mpu = sum / agreeing.size;
    const nice = gridded && NICE_GRIDS.some((g) => Math.abs(mpu - g) <= 0.03 * g);
    if (
      !best ||
      agreeing.size > best.agreeing.length ||
      (agreeing.size === best.agreeing.length && nice && !best.nice)
    ) {
      best = { mpu, agreeing: [...agreeing], nice };
    }
  }
  if (!best || best.agreeing.length < 2) return null;
  const examples = best.agreeing
    .slice(0, 3)
    .map((d) => `"${d.text}"`)
    .join(', ');
  return {
    source: 'dimensions',
    metresPerUnit: best.mpu,
    detail: `${best.agreeing.length} of ${dimensions.length} dimension lines agree (${examples})`,
    agreeing: best.agreeing,
  };
}

export function decideScale(
  candidates: ScaleCandidate[],
  calibration: ScaleCandidate | null,
): ScaleDecision {
  if (calibration) {
    const others = candidates.filter((c) => c.source !== 'calibration');
    const disagree = others.filter(
      (c) =>
        Math.abs(c.metresPerUnit - calibration.metresPerUnit) >
        SCALE_AGREEMENT * calibration.metresPerUnit,
    );
    return {
      metresPerUnit: calibration.metresPerUnit,
      status: 'calibrated',
      candidates: [calibration, ...others],
      note: disagree.length
        ? `Set by you; the plan's ${disagree.map((c) => c.source).join(', ')} evidence disagrees.`
        : 'Set by you.',
    };
  }
  if (!candidates.length) {
    return {
      metresPerUnit: null,
      status: 'unknown',
      candidates,
      note: 'The plan states no grid size, units or readable dimensions. Set the scale.',
    };
  }
  const [first, ...rest] = candidates;
  const agree = rest.filter(
    (c) => Math.abs(c.metresPerUnit - first.metresPerUnit) <= SCALE_AGREEMENT * first.metresPerUnit,
  );
  if (agree.length === rest.length) {
    const mean = [first, ...rest].reduce((sum, c) => sum + c.metresPerUnit, 0) / (rest.length + 1);
    return {
      metresPerUnit: mean,
      status: rest.length ? 'verified' : 'single',
      candidates,
      note: rest.length
        ? `${rest.length + 1} independent sources agree.`
        : 'One source; nothing on the plan to cross-check it against.',
    };
  }
  return {
    metresPerUnit: null,
    status: 'conflict',
    candidates,
    note: 'The plan’s scale evidence disagrees. Choose which is right, or set the scale.',
  };
}
