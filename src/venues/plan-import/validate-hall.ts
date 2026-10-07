import type { SheetAnalysis } from '../../integrations/drawings/drawing-analysis';
import type { ScaleDecision } from '../../integrations/drawings/scale';
import { floorProblems } from '../floor/hall-floor';
import type { BuiltHall } from './build-hall';
import type { DetectedHall } from './detect-halls';

/**
 * Checks of one imported hall against the plan's own evidence. A check passes only on
 * evidence; where the plan gives none it is `unknown`, never `pass`. Failed checks block the
 * hall's save until fixed, or acknowledged where acknowledging makes sense.
 */

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'info';

export interface HallCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** What on the plan the check rests on. */
  evidence: string;
  expected: string | null;
  measured: string | null;
  tolerance: string | null;
  /** Saving waits for this check (when it fails, or is unknown and must be confirmed). */
  blocking: boolean;
  /** The person may acknowledge it and save anyway (false: it must be fixed). */
  acknowledgeable: boolean;
  acknowledged: boolean;
}

/** Printed dimensions are compared within this many metres. */
export const DIMENSION_TOLERANCE = 0.5;
/** A dimension line's ends must lie this close to the hall's edges (metres) to measure it. */
const DIMENSION_REACH = 1.0;
/** How far beside the hall a dimension line may be printed (metres). */
const DIMENSION_OFFSET = 40;
/** A printed area is compared within this share. */
const AREA_TOLERANCE = 0.02;
/** A square grid's two pitches agree within this share. */
const SQUARE_TOLERANCE = 0.015;

export interface GroupEvidence {
  groupId: number;
  color: string;
  from: 'legend' | 'colour' | 'you';
  conflict: string | null;
  areaInHall: number;
}

export function validateHall(input: {
  sheet: SheetAnalysis;
  hall: DetectedHall;
  built: BuiltHall;
  scale: ScaleDecision;
  groups: GroupEvidence[];
  pendingTexts: number;
  acknowledged: ReadonlySet<string>;
}): HallCheck[] {
  const { sheet, hall, built, scale } = input;
  const checks: HallCheck[] = [];
  const add = (c: Omit<HallCheck, 'acknowledged'>) =>
    checks.push({ ...c, acknowledged: c.acknowledgeable && input.acknowledged.has(c.id) });
  const mpu = scale.metresPerUnit;
  const m = (v: number) => `${v.toFixed(2)} m`;

  // Name.
  add({
    id: 'name',
    label: 'Hall name',
    status: hall.name.trim() ? 'pass' : 'fail',
    evidence:
      hall.nameFrom === 'plan'
        ? 'Printed on the plan beside or inside this floor'
        : hall.nameFrom === 'sheet-title'
          ? 'The sheet’s title'
          : hall.nameFrom === 'you'
            ? 'Given by you'
            : 'The plan prints no name for this floor',
    expected: null,
    measured: hall.name || null,
    tolerance: null,
    blocking: !hall.name.trim(),
    acknowledgeable: false,
  });

  // Scale.
  const evidence = scale.candidates
    .map((c) => `${c.detail} → ${c.metresPerUnit.toFixed(4)} m`)
    .join('; ');
  add({
    id: 'scale',
    label: sheet.map.source === 'grid' ? 'Scale (grid cell size)' : 'Scale',
    status:
      scale.status === 'verified' || scale.status === 'calibrated'
        ? 'pass'
        : scale.status === 'single'
          ? 'unknown'
          : 'fail',
    evidence: evidence ? `${scale.note} ${evidence}` : scale.note,
    expected: null,
    measured: mpu
      ? `${mpu.toFixed(4)} m per ${sheet.map.source === 'grid' ? 'grid cell' : 'unit'}`
      : null,
    tolerance: '±2% between sources',
    blocking: scale.status === 'conflict' || scale.status === 'unknown',
    acknowledgeable: false,
  });

  // Stated grid size.
  if (sheet.map.source === 'grid') {
    if (sheet.statedGrid && mpu) {
      const ok = Math.abs(sheet.statedGrid.metres - mpu) <= 0.02 * sheet.statedGrid.metres;
      add({
        id: 'stated-grid',
        label: 'Grid size printed on the plan',
        status: ok ? 'pass' : 'fail',
        evidence: `"${sheet.statedGrid.text}"`,
        expected: m(sheet.statedGrid.metres),
        measured: m(mpu),
        tolerance: '±2%',
        blocking: !ok,
        acknowledgeable: true,
      });
    } else {
      add({
        id: 'stated-grid',
        label: 'Grid size printed on the plan',
        status: 'unknown',
        evidence: 'The plan does not print its grid size.',
        expected: null,
        measured: mpu ? m(mpu) : null,
        tolerance: null,
        blocking: false,
        acknowledgeable: false,
      });
    }

    // Square grid.
    const px = sheet.map.unitPxX;
    const py = sheet.map.unitPxY;
    const share = Math.abs(px - py) / Math.max(px, py);
    const square = sheet.statedGrid !== null;
    add({
      id: 'grid-square',
      label: 'Grid cells square on the file',
      status: square ? (share <= SQUARE_TOLERANCE ? 'pass' : 'fail') : 'unknown',
      evidence: square
        ? `The plan states a square grid ("${sheet.statedGrid!.text}").`
        : 'The plan does not state that its grid is square.',
      expected: square ? 'equal pitch on both axes' : null,
      measured: `${px.toFixed(2)} × ${py.toFixed(2)} px (${(share * 100).toFixed(1)}% apart)`,
      tolerance: `±${SQUARE_TOLERANCE * 100}%`,
      blocking: square && share > SQUARE_TOLERANCE,
      acknowledgeable: true,
    });
  }

  // Dimension lines that measure this hall's width or depth.
  if (mpu) {
    const reach = DIMENSION_REACH / mpu;
    const offset = DIMENSION_OFFSET / mpu;
    const b = built.box;
    let found = 0;
    for (const [i, d] of sheet.dimensions.entries()) {
      const along = d.vertical ? [d.y1, d.y2] : [d.x1, d.x2];
      const lo = Math.min(...along);
      const hi = Math.max(...along);
      const [start, end] = d.vertical ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
      const across = d.vertical ? d.x1 : d.y1;
      const [aLo, aHi] = d.vertical ? [b.x, b.x + b.width] : [b.y, b.y + b.height];
      if (Math.abs(lo - start) > reach || Math.abs(hi - end) > reach) continue;
      if (across < aLo - offset || across > aHi + offset) continue;
      const measured = d.vertical ? built.stats.depth : built.stats.width;
      const factor = unitFactor(d.value, d.unit, d.units * mpu);
      const expected = d.value * factor;
      const ok = Math.abs(expected - measured) <= DIMENSION_TOLERANCE;
      found++;
      add({
        id: `dimension-${i}`,
        label: `Printed ${d.vertical ? 'depth' : 'width'} "${d.text}"`,
        status: ok ? 'pass' : 'fail',
        evidence: `A dimension line spanning the hall's ${d.vertical ? 'depth' : 'width'}${factor === 0.001 ? ' (read as millimetres)' : ''}.`,
        expected: m(expected),
        measured: m(measured),
        tolerance: `±${DIMENSION_TOLERANCE} m`,
        blocking: !ok,
        acknowledgeable: true,
      });
    }
    if (!found) {
      add({
        id: 'dimension',
        label: 'Printed hall dimensions',
        status: 'unknown',
        evidence: sheet.dimensions.length
          ? 'No dimension line on the plan spans this hall’s full width or depth.'
          : 'No dimension lines were read on the plan.',
        expected: null,
        measured: `${m(built.stats.width)} × ${m(built.stats.depth)}`,
        tolerance: null,
        blocking: false,
        acknowledgeable: false,
      });
    }

    // Every dimension line on the sheet against the scale.
    const readable = sheet.dimensions.filter((d) => d.units > 0);
    if (readable.length) {
      const consistent = readable.filter((d) => {
        const length = d.units * mpu;
        return (
          Math.abs(d.value * unitFactor(d.value, d.unit, length) - length) <= DIMENSION_TOLERANCE
        );
      });
      const share = consistent.length / readable.length;
      add({
        id: 'dimension-scale',
        label: 'All dimension lines on the sheet',
        status:
          readable.length < 2
            ? 'unknown'
            : share >= 0.8
              ? 'pass'
              : share < 0.5
                ? 'fail'
                : 'unknown',
        evidence: `${consistent.length} of ${readable.length} dimension lines measure as printed (e.g. ${readable
          .slice(0, 4)
          .map((d) => `"${d.text}" = ${(d.units * mpu).toFixed(2)} m`)
          .join(', ')}).`,
        expected: null,
        measured: `${Math.round(share * 100)}% agree`,
        tolerance: `±${DIMENSION_TOLERANCE} m each`,
        blocking: readable.length >= 2 && share < 0.5,
        acknowledgeable: true,
      });
    }
  }

  // Printed area: compared only when the plan says which area it is.
  if (hall.printedArea) {
    const text = hall.printedArea.text;
    const expected = hall.printedArea.value;
    const type = /\b(gross|built[\s-]?up|total)\b/i.test(text)
      ? 'gross'
      : /\b(carpet|net|usable|exhibition (?:area|space)|stall area)\b/i.test(text)
        ? 'net'
        : null;
    const measured = type === 'net' ? built.stats.stallFloor : built.stats.gross;
    const ok = Math.abs(expected - measured) <= AREA_TOLERANCE * expected;
    add({
      id: 'printed-area',
      label: 'Printed hall area',
      status: type ? (ok ? 'pass' : 'fail') : 'unknown',
      evidence: type
        ? `"${text}", compared with the hall's ${type === 'gross' ? 'gross floor (bands included, foyer and voids excluded)' : 'stall floor'}.`
        : `"${text}". The plan does not say whether this is the gross or the usable area, so it is not compared.`,
      expected: `${expected.toFixed(0)} m²`,
      measured: type
        ? `${measured.toFixed(0)} m²`
        : `gross ${built.stats.gross.toFixed(0)} m², stall floor ${built.stats.stallFloor.toFixed(0)} m²`,
      tolerance: `±${AREA_TOLERANCE * 100}%`,
      blocking: type !== null && !ok,
      acknowledgeable: true,
    });
  }

  // Geometry.
  const problems = floorProblems(built.floor);
  add({
    id: 'geometry',
    label: 'Valid geometry',
    status: problems.length ? 'fail' : 'pass',
    evidence: problems.length
      ? problems.join(' ')
      : 'All rectangles have a size and lie on the floor; areas do not overlap.',
    expected: null,
    measured: `${built.floor.areas.length} areas, ${(built.floor.zones ?? []).reduce((n, z) => n + z.rects.length, 0)} zone rectangles`,
    tolerance: null,
    blocking: problems.length > 0,
    acknowledgeable: false,
  });

  // Boundary from walls (no grid): a proposal.
  if (sheet.map.source === 'outline') {
    add({
      id: 'boundary',
      label: 'Hall boundary',
      status: 'unknown',
      evidence: 'The plan has no stall grid: the boundary is the space enclosed by drawn lines.',
      expected: null,
      measured: null,
      tolerance: null,
      blocking: true,
      acknowledgeable: true,
    });
  }

  // Colours on this hall's floor.
  for (const g of input.groups) {
    if (g.areaInHall <= 0) continue;
    if (g.conflict) {
      add({
        id: `legend-${g.groupId}`,
        label: `Meaning of colour ${g.color}`,
        status: 'fail',
        evidence: g.conflict,
        expected: null,
        measured: null,
        tolerance: null,
        blocking: true,
        acknowledgeable: true,
      });
    } else if (g.from === 'colour') {
      add({
        id: `legend-${g.groupId}`,
        label: `Meaning of colour ${g.color}`,
        status: 'unknown',
        evidence:
          'The plan’s legend does not name this colour; its kind is a guess from the colour.',
        expected: null,
        measured: `${g.areaInHall.toFixed(0)} m²`,
        tolerance: null,
        blocking: false,
        acknowledgeable: false,
      });
    }
  }

  // Issues found while separating halls.
  for (const issue of hall.issues) {
    add({
      id: issue.id,
      label: issue.id.startsWith('shared')
        ? 'Shared floor'
        : issue.id === 'separation'
          ? 'Halls separated'
          : issue.id === 'duplicate'
            ? 'Duplicate'
            : 'Foyer',
      status: issue.severity === 'block' ? 'fail' : 'info',
      evidence: issue.message,
      expected: null,
      measured: null,
      tolerance: null,
      blocking: issue.severity === 'block',
      acknowledgeable: true,
    });
  }

  // How fine the plan is.
  const metresPerPx = mpu ? mpu / ((sheet.map.unitPxX + sheet.map.unitPxY) / 2) : null;
  add({
    id: 'resolution',
    label: 'Resolution',
    status: 'info',
    evidence:
      sheet.format === 'pdf-scan' || sheet.format === 'image'
        ? 'A picture of the plan: edges are known to about a pixel.'
        : 'A drawing: edges come from its lines.',
    expected: null,
    measured: metresPerPx ? `1 px ≈ ${(metresPerPx * 100).toFixed(1)} cm` : null,
    tolerance: null,
    blocking: false,
    acknowledgeable: false,
  });

  if (input.pendingTexts) {
    add({
      id: 'texts',
      label: 'Texts to confirm',
      status: 'info',
      evidence: `${input.pendingTexts} texts near this hall were read with doubt and are left off until confirmed.`,
      expected: null,
      measured: null,
      tolerance: null,
      blocking: false,
      acknowledgeable: false,
    });
  }
  return checks;
}

/** Whether a hall's checks let it be saved. */
export function saveable(checks: HallCheck[]): boolean {
  return checks.every((c) => !c.blocking || c.acknowledged);
}

/**
 * The factor that turns a printed number into metres: its printed unit, else metres, unless
 * millimetres fit the measured length and metres do not (CAD plans print millimetres bare).
 */
function unitFactor(
  value: number,
  unit: 'm' | 'mm' | 'cm' | 'ft' | null,
  measured: number,
): number {
  if (unit === 'mm') return 0.001;
  if (unit === 'cm') return 0.01;
  if (unit === 'ft') return 0.3048;
  if (unit === 'm') return 1;
  return Math.abs(value * 0.001 - measured) < Math.abs(value - measured) ? 0.001 : 1;
}
