import type { PlanTextReading } from '../../ai/plan-text-reader.service';
import type { PlanTextKind } from '../../ai/plan-texts';
import type { DrawingAnalysis, SheetAnalysis } from '../../integrations/drawings/drawing-analysis';
import type { GroupChoice, OverlayGroup } from '../../integrations/drawings/grid-map';
import {
  decideScale,
  dimensionScale,
  ScaleCandidate,
  ScaleDecision,
} from '../../integrations/drawings/scale';
import type { FloorAreaKind, HallFloor } from '../floor/hall-floor';
import { buildHall, BuiltHall, HallStats, HOLE, ReviewedText } from './build-hall';
import {
  detectSheetHalls,
  DetectedHall,
  HallOverrides,
  markDuplicates,
  PartView,
  SheetHalls,
} from './detect-halls';
import { PartCut, sheetParts, SheetParts } from './sheet-parts';
import { GroupEvidence, HallCheck, saveable, validateHall } from './validate-hall';

/**
 * The whole review of one imported file: every sheet's scale, parts, colours, texts and halls,
 * with each hall's floor and checks, for the person's current decisions. Pure: the same
 * analysis, readings and decisions always give the same review.
 */

/** Everything the person has decided so far. All optional: an empty state is the proposal. */
export interface ReviewState {
  /** Page -> the scale the person set. */
  calibrations: Record<number, { metresPerUnit: number; detail: string }>;
  /** Page -> cuts. */
  cuts: Record<number, PartCut[]>;
  overrides: HallOverrides;
  /** `page:groupId` -> what the colour is. */
  groups: Record<string, GroupChoice>;
  /** Hall key -> what its enclosed gaps are. */
  holes: Record<string, GroupChoice>;
  /** `page:textIndex` -> what the text is. */
  texts: Record<string, PlanTextKind>;
  /** Hall key -> acknowledged check ids. */
  acks: Record<string, string[]>;
}

export function emptyReviewState(): ReviewState {
  return {
    calibrations: {},
    cuts: {},
    overrides: { assign: {}, names: {} },
    groups: {},
    holes: {},
    texts: {},
    acks: {},
  };
}

export interface GroupView {
  id: number;
  color: string;
  family: string;
  choice: GroupChoice;
  from: 'legend' | 'colour' | 'you';
  legend: string | null;
  conflict: string | null;
}

export interface TextView extends ReviewedText {
  x: number;
  y: number;
  width: number;
  height: number;
  source: 'file' | 'ocr';
}

export interface HallReview {
  key: string;
  page: number;
  name: string;
  nameFrom: DetectedHall['nameFrom'];
  parts: DetectedHall['parts'];
  duplicateOf: string | null;
  floor: HallFloor;
  stats: HallStats;
  /** Placement on the sheet's map, map units. */
  box: BuiltHall['box'];
  holeChoice: GroupChoice;
  checks: HallCheck[];
  saveable: boolean;
}

export interface SheetReview {
  page: number;
  scale: ScaleDecision;
  /** The scale used to show the floor: the decided one, or 1 unit = 1 m while unknown. */
  metresPerUnit: number;
  provisional: boolean;
  parts: PartView[];
  groups: GroupView[];
  texts: TextView[];
  halls: HallReview[];
}

/** Legend swatches this close in colour to a group name it. */
const LEGEND_COLOR_DISTANCE = 70;

export function reviewImport(
  analysis: DrawingAnalysis,
  readings: ReadonlyMap<string, PlanTextReading>,
  state: ReviewState,
  cache?: Map<string, SheetParts>,
): SheetReview[] {
  const prepared = analysis.sheets.map((sheet) => {
    const scale = sheetScale(sheet, state);
    const cuts = state.cuts[sheet.page] ?? [];
    const cacheKey = `${sheet.page}:${JSON.stringify(cuts)}`;
    let parts = cache?.get(cacheKey);
    if (!parts) {
      parts = sheetParts(sheet, cuts);
      cache?.set(cacheKey, parts);
    }
    const texts = reviewedTexts(sheet, readings, state);
    const groups = groupViews(sheet, texts, state);
    const detected = detectSheetHalls(sheet, parts, readings, scale.metresPerUnit, state.overrides);
    return { sheet, scale, parts, texts, groups, detected };
  });

  // Build every hall, then mark repeats across pages, then check.
  const built = new Map<string, BuiltHall>();
  for (const p of prepared) {
    const mpu = p.scale.metresPerUnit ?? 1;
    const choices = new Map(p.groups.map((g) => [g.id, g.choice]));
    for (const hall of p.detected.halls) {
      built.set(
        hall.key,
        buildHall({
          fileName: analysis.fileName,
          sheet: p.sheet,
          parts: p.parts,
          hall,
          metresPerUnit: mpu,
          scaleSource: p.scale.metresPerUnit
            ? `${p.scale.status}: ${p.scale.note}`
            : 'Scale unknown when built',
          groupChoices: choices,
          holeChoice: state.holes[hall.key] ?? 'void',
          texts: p.texts,
        }),
      );
    }
  }
  markDuplicates(
    prepared.map((p) => p.detected),
    (hall) => built.get(hall.key)?.stats.gross ?? 0,
  );

  return prepared.map((p): SheetReview => {
    const halls = p.detected.halls.map((hall): HallReview => {
      const b = built.get(hall.key)!;
      const inHall = new Map(b.stats.bands.map((band) => [band.groupId, band.area]));
      const evidence: GroupEvidence[] = p.groups.map((g) => ({
        groupId: g.id,
        color: g.color,
        from: g.from,
        conflict: g.conflict,
        areaInHall: inHall.get(g.id) ?? 0,
      }));
      const pendingTexts = p.texts.filter((t) => {
        if (!t.review) return false;
        const x = t.x + t.width / 2;
        const y = t.y + t.height / 2;
        return (
          x >= b.box.x - 8 &&
          y >= b.box.y - 8 &&
          x <= b.box.x + b.box.width + 8 &&
          y <= b.box.y + b.box.height + 8
        );
      }).length;
      const checks = validateHall({
        sheet: p.sheet,
        hall,
        built: b,
        scale: p.scale,
        groups: evidence,
        pendingTexts,
        acknowledged: new Set(state.acks[hall.key] ?? []),
      });
      return {
        key: hall.key,
        page: hall.page,
        name: hall.name,
        nameFrom: hall.nameFrom,
        parts: hall.parts,
        duplicateOf: hall.duplicateOf,
        floor: b.floor,
        stats: b.stats,
        box: b.box,
        holeChoice: state.holes[hall.key] ?? 'void',
        checks,
        saveable: saveable(checks),
      };
    });
    return {
      page: p.sheet.page,
      scale: p.scale,
      metresPerUnit: p.scale.metresPerUnit ?? 1,
      provisional: p.scale.metresPerUnit === null,
      parts: p.detected.parts,
      groups: p.groups,
      texts: p.texts,
      halls,
    };
  });
}

/** The scale of one sheet from its evidence and the person's calibration. */
export function sheetScale(sheet: SheetAnalysis, state: ReviewState): ScaleDecision {
  const candidates: ScaleCandidate[] = [];
  if (sheet.fileScale) {
    candidates.push({
      source: 'file',
      metresPerUnit: sheet.fileScale.metresPerUnit,
      detail: sheet.fileScale.detail,
    });
  }
  if (sheet.statedGrid && sheet.map.source === 'grid') {
    candidates.push({
      source: 'stated-grid',
      metresPerUnit: sheet.statedGrid.metres,
      detail: `The plan states "${sheet.statedGrid.text}"`,
    });
  }
  const dims = dimensionScale(sheet.dimensions, sheet.map.source === 'grid');
  if (dims) {
    candidates.push({
      source: 'dimensions',
      metresPerUnit: dims.metresPerUnit,
      detail: dims.detail,
    });
  }
  const calibration = state.calibrations[sheet.page];
  return decideScale(
    candidates,
    calibration
      ? {
          source: 'calibration',
          metresPerUnit: calibration.metresPerUnit,
          detail: calibration.detail,
        }
      : null,
  );
}

function reviewedTexts(
  sheet: SheetAnalysis,
  readings: ReadonlyMap<string, PlanTextReading>,
  state: ReviewState,
): TextView[] {
  return sheet.texts.map((t, index) => {
    const reading = readings.get(t.text.replace(/\s+/g, ' ').trim());
    const chosen = state.texts[`${sheet.page}:${index}`];
    return {
      index,
      text: t.text,
      kind: chosen ?? reading?.kind ?? 'none',
      review: chosen ? false : (reading?.review ?? false),
      by: chosen ? 'you' : (reading?.by ?? 'default'),
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      source: t.source,
    };
  });
}

/**
 * What each colour on the floor is: the person's choice, else the plan's own legend (a row
 * whose swatch matches the colour), else a guess from the colour. Legend rows that give one
 * colour two meanings are a conflict to resolve, not a choice to make silently.
 */
function groupViews(sheet: SheetAnalysis, texts: TextView[], state: ReviewState): GroupView[] {
  return sheet.map.groups.map((g: OverlayGroup) => {
    const rows = texts
      .filter((t) => !t.review && t.kind.startsWith('area:'))
      .map((t) => ({ t, swatch: sheet.texts[t.index].swatch }))
      .filter(
        (r) =>
          r.swatch &&
          r.swatch.family === g.family &&
          colorDistance(r.swatch.color, g.color) <= LEGEND_COLOR_DISTANCE,
      )
      .sort(
        (a, b) => colorDistance(a.swatch!.color, g.color) - colorDistance(b.swatch!.color, g.color),
      );
    const kinds = [...new Set(rows.map((r) => r.t.kind.slice(5)))];
    const mine = state.groups[`${sheet.page}:${g.id}`];
    const conflict =
      kinds.length > 1 && !mine
        ? `The legend gives this colour ${kinds.length} meanings: ${rows
            .slice(0, 3)
            .map((r) => `"${r.t.text}"`)
            .join(', ')}. Choose which is right.`
        : null;
    const fromLegend = rows[0];
    return {
      id: g.id,
      color: g.color,
      family: g.family,
      choice: mine ?? (fromLegend ? (fromLegend.t.kind.slice(5) as FloorAreaKind) : g.kind),
      from: mine ? 'you' : fromLegend ? 'legend' : 'colour',
      legend: fromLegend?.t.text ?? null,
      conflict,
    };
  });
}

function colorDistance(a: string, b: string): number {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
}

export { HOLE };
export type { SheetHalls };
