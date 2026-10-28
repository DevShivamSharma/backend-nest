import { drawingProfile } from '../../rules/domain/drawing-profiles';
import type { EventType, RuleSwitches, RuleValues } from '../../rules/domain/rule-catalogue';
import type { HallFloor } from './hall-floor';
import { ringArea } from './geometry';
import type { PlanContent, PlanObjectView, PlanZoneView } from './plan.model';
import { checkPlan, PlanFinding } from './plan-check';
import { cleanCutCells } from './stall-cells';

/** Broken rules named in a refusal; the rest are counted. */
const NAMED = 3;

/** What a plan is, as it comes to be saved or checked: the stored shape, before zone areas are worked out. */
export type PlanDraft = Omit<PlanContent, 'zones'> & {
  zones: Array<Omit<PlanZoneView, 'area'>>;
};

/** What an event hall's rules need to check a plan. */
export interface PlanRulesContext {
  floor: HallFloor;
  switches: RuleSwitches;
  values: RuleValues;
  eventType: EventType;
  drawingProfile: string;
}

/** A stall's full number, as ITPO writes it: island and stall, e.g. "12A-27 E". */
export function stallNumber(s: { islandNumber?: string | null; stallNumber: string }): string {
  return s.islandNumber ? `${s.islandNumber}${s.stallNumber}` : s.stallNumber;
}

/**
 * What is wrong with a drawing's shape, in words; null when nothing. The DTO has checked each
 * point; this checks how many there are for the kind, and that the shape has a size.
 */
export function objectProblem(o: Pick<PlanObjectView, 'kind' | 'points' | 'text'>): string | null {
  const [a, b] = o.points;
  switch (o.kind) {
    case 'line':
      return o.points.length !== 2 ? 'A line is drawn with exactly 2 points.' : null;
    case 'rect':
      if (o.points.length !== 2) return 'A rectangle is drawn with 2 opposite corners.';
      return a[0] === b[0] || a[1] === b[1] ? 'A rectangle has no area.' : null;
    case 'circle':
      if (o.points.length !== 2) {
        return 'A circle is drawn with its centre and a point on its edge.';
      }
      return Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0 ? 'A circle has no radius.' : null;
    case 'polyline':
      return o.points.length < 2 ? 'A polyline is drawn with 2 to 500 points.' : null;
    case 'text':
      if (o.points.length !== 1) return 'A text is placed with exactly 1 point.';
      return !o.text ? 'A text drawing needs some text.' : null;
  }
}

/** What makes the plan unsound before any rule: ids, numbers, zones, categories and drawings. */
export function planStructure(plan: PlanDraft, sells: ReadonlySet<string>): PlanFinding[] {
  const out: PlanFinding[] = [];
  const ids = new Set<string>();
  for (const item of [...plan.zones, ...plan.stalls, ...plan.seats, ...plan.objects]) {
    if (ids.has(item.id)) {
      out.push({ ruleId: 'plan', message: 'An id appears twice.', ids: [item.id] });
    }
    ids.add(item.id);
  }
  const zones = new Set(plan.zones.map((z) => z.id));
  const numbers = new Map<string, string>();
  for (const s of plan.stalls) {
    const number = stallNumber(s);
    const twin = numbers.get(number.toLowerCase());
    if (twin) {
      out.push({
        ruleId: 'plan',
        message: `Two stalls are numbered ${number}.`,
        ids: [twin, s.id],
      });
    } else {
      numbers.set(number.toLowerCase(), s.id);
    }
    if (s.zoneId && !zones.has(s.zoneId)) {
      out.push({
        ruleId: 'plan',
        message: `Stall ${number} is in a zone that is gone.`,
        ids: [s.id],
      });
    }
    if (s.categoryIds.some((c) => !sells.has(c))) {
      out.push({
        ruleId: 'plan',
        message: `Stall ${number} has a category this hall does not sell.`,
        ids: [s.id],
      });
    }
  }
  for (const s of plan.seats) {
    if (s.zoneId && !zones.has(s.zoneId)) {
      out.push({
        ruleId: 'plan',
        message: `Seat ${s.rowLabel}-${s.seatNumber} is in a zone that is gone.`,
        ids: [s.id],
      });
    }
    if (s.categoryId && !sells.has(s.categoryId)) {
      out.push({
        ruleId: 'plan',
        message: `Seat ${s.rowLabel}-${s.seatNumber} has a category this hall does not sell.`,
        ids: [s.id],
      });
    }
  }
  for (const z of plan.zones) {
    if (ringArea(z.polygon) < 0.01) {
      out.push({ ruleId: 'plan', message: `Zone ${z.name} has no area.`, ids: [z.id] });
    }
  }
  for (const o of plan.objects) {
    const problem = objectProblem(o);
    if (problem) out.push({ ruleId: 'plan', message: problem, ids: [o.id] });
  }
  return out;
}

/** The rules of the event hall, over the whole plan. */
export function planRules(plan: PlanDraft, rules: PlanRulesContext): PlanFinding[] {
  return checkPlan({
    floor: rules.floor,
    switches: rules.switches,
    values: rules.values,
    eventType: rules.eventType,
    profile: drawingProfile(rules.drawingProfile),
    zones: plan.zones.map((z) => ({ id: z.id, name: z.name, polygon: z.polygon })),
    stalls: plan.stalls.map((s) => ({
      id: s.id,
      number: stallNumber(s),
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
      openSides: [...new Set(s.openSides)],
      cutCells: cleanCutCells(s, s.cutCells ?? []),
    })),
    seats: plan.seats.map((s) => ({
      id: s.id,
      label: `${s.rowLabel}-${s.seatNumber}`,
      x: s.x,
      y: s.y,
      width: s.width,
      depth: s.depth,
    })),
  });
}

/** A refusal in one sentence: the first rules broken, and how many more. */
export function refusal(problems: readonly PlanFinding[], was = 'saved'): string {
  const named = problems.slice(0, NAMED).map((p) => p.message);
  const more = problems.length - named.length;
  return `The plan was not ${was}: ${named.join(' ')}${more ? ` And ${more} more.` : ''}`;
}
