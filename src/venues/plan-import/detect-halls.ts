import type { PlanTextReading } from '../../ai/plan-text-reader.service';
import type { AnalysedText, SheetAnalysis } from '../../integrations/drawings/drawing-analysis';
import { gapKey, SheetParts } from './sheet-parts';

/**
 * Which parts of a sheet make which hall. The plan's own titles ("HALL 12", "EXHIBITION
 * HALL 6") name and anchor halls; untitled pieces join the hall they touch; a part marked as a
 * foyer belongs to the hall it serves, and one between two halls is shared until the person
 * decides. Nothing is split or merged on a guess the plan does not support: such cases become
 * issues for the person to resolve.
 */

export type PartRole = 'floor' | 'foyer' | 'circulation';

/** The person's decision for one part: in a hall (with a role), or in no hall. */
export interface PartAssignment {
  hall: string | null;
  role: PartRole;
}

export interface HallIssue {
  id: string;
  /** block: must be resolved or acknowledged before saving; note: for information. */
  severity: 'block' | 'note';
  message: string;
}

export interface DetectedHall {
  /** Stable key: `<page>:<anchor part>`, or the key the person gave a new hall. */
  key: string;
  page: number;
  name: string;
  /** Where the name comes from. */
  nameFrom: 'plan' | 'sheet-title' | 'you' | 'none';
  parts: Array<{ id: number; role: PartRole; inferred: boolean }>;
  /** A printed area naming this hall ("HALL 12 = 1681.00 SQ.M."), to check against. */
  printedArea: { value: number; text: string } | null;
  issues: HallIssue[];
  /** The key of the same hall found on an earlier page. */
  duplicateOf: string | null;
}

export interface PartView {
  id: number;
  /** Map units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Map units squared. */
  area: number;
  assignment: PartAssignment | null;
  /** How the assignment was made. */
  by: 'title' | 'touching' | 'layout' | 'foyer-label' | 'you' | 'none';
  /** Hall titles found in or by it. */
  titles: string[];
  foyerLabel: string | null;
  /** Halls it could belong to when that is undecided. */
  candidates: string[];
  noise: boolean;
}

export interface SheetHalls {
  page: number;
  halls: DetectedHall[];
  parts: PartView[];
}

export interface HallOverrides {
  /** Part id -> decision, per page. */
  assign: Record<number, Record<number, PartAssignment>>;
  /** Hall key -> name. */
  names: Record<string, string>;
}

/**
 * A gap this narrow (metres), between pieces drawn on the same grid, is a line drawn across one
 * floor (a column line, a services trench), not a wall between halls.
 */
const SAME_FLOOR_GAP = 5;
/** An untitled piece at least this share of the sheet's largest is a hall of its own. */
const UNTITLED_HALL_SHARE = 0.15;
/** A foyer this close (metres) to a hall serves it. */
const FOYER_REACH = 12;
/** A title this far (metres) from a part still names it (titles are printed beside halls). */
const TITLE_REACH = 15;
/** Floor pieces smaller than this (m²) are drawing noise. */
const MIN_PART_AREA = 20;
/** An untitled piece beside a hall, smaller than this share of it, reads as its foyer. */
const FOYER_SHARE = 0.35;

const HALL_TITLE =
  /\b(?:exhibition\s+|exh\.\s*)?(halls?|hal(?=\s*[-–#]?\s*\d)|halle|pavilions?|pavillon|pabell[oó]n|hangars?|sala|salle|arena)(?![a-z])\s*(?:no\.?\s*)?[-–—#:.]?\s*([0-9]{1,3}\s?[a-z]{0,2}|[a-z]{1,2}[0-9]{0,2})(?![a-z])/i;
const FOYER =
  /\b(foyer|fover|lobby|pre-?function|concourse|vestibule)\b(?:\s*[-–#:.]?\s*([0-9]{1,3}\s?[a-z]{0,2}|[a-z]))?/i;
const PRINTED_AREA = /[=:]\s*([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*m(?:t|tr|ts)?\.?|m2|m²|sqm)\b/i;
/** Signs pointing to another hall ("FROM HALL-12A", "Entry to Hall 5") name no floor here. */
const DIRECTION = /\b(to|from|towards|via|entry|exit|entrance|gate|connecting|link|bridge|way)\b/i;

/** "HALL 12A", "Hall-14" -> "Hall 12A"; null when the text names no single hall. */
export function hallNameOf(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length > 60 || DIRECTION.test(t) || FOYER.test(t)) return null;
  const m = HALL_TITLE.exec(t);
  if (!m) return null;
  // "HALLS 8, 9, 10 & 11", "Hall 12-12A" name several halls: not one hall's title.
  if (/\d\s*(,|&|and|-|–|\/)\s*\d/i.test(t.slice(m.index))) return null;
  const word = /^hal(l|ls)?$/i.test(m[1]) ? 'Hall' : cap(m[1].replace(/s$/i, ''));
  return `${word} ${m[2].replace(/\s+/g, '').toUpperCase()}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** The hall's number or letter, for matching "FOYER-6" to "Hall 6". */
function hallTag(name: string): string {
  return name.split(' ').pop()!.toUpperCase();
}

export function detectSheetHalls(
  sheet: SheetAnalysis,
  parts: SheetParts,
  readings: ReadonlyMap<string, PlanTextReading>,
  metresPerUnit: number | null,
  overrides: HallOverrides,
): SheetHalls {
  const mpu = metresPerUnit ?? 1;
  const m2 = (cells: number) => (cells / (parts.sub * parts.sub)) * mpu * mpu;
  const unitsFor = (metres: number) => metres / mpu;

  // Titles and foyer labels, and the part each one is in or beside.
  const views: PartView[] = parts.parts.map((p) => ({
    id: p.id,
    x: p.x0 / parts.sub,
    y: p.y0 / parts.sub,
    width: (p.x1 - p.x0 + 1) / parts.sub,
    height: (p.y1 - p.y0 + 1) / parts.sub,
    area: p.cells / (parts.sub * parts.sub),
    assignment: null,
    by: 'none',
    titles: [],
    foyerLabel: null,
    candidates: [],
    noise: m2(p.cells) < MIN_PART_AREA,
  }));
  const printedAreas = new Map<string, { value: number; text: string }>();
  // Hall titles print larger than the plan's other words; a small "HALL 11" by a wall labels
  // the neighbouring hall, not this floor.
  const heights = sheet.texts.map((t) => Math.min(t.width, t.height)).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const partTitles = new Map<number, Map<string, number>>();
  const sheetTitles = new Map<string, number>();
  const note = (map: Map<string, number>, name: string, size: number) =>
    map.set(name, Math.max(map.get(name) ?? 0, size));
  for (const t of sheet.texts) {
    const kind = readings.get(key(t.text))?.kind;
    // Facility names and legend rows are never hall titles.
    if (kind && (kind.startsWith('icon:') || kind.startsWith('area:'))) continue;
    const name = hallNameOf(t.text);
    const foyer = name ? null : FOYER.exec(t.text);
    if (!name && !foyer) continue;
    const size = Math.min(t.width, t.height);
    const large = size >= 1.3 * medianHeight;
    const part = partAt(t, parts, views, unitsFor(TITLE_REACH), name !== null && !large);
    if (name) {
      const area = PRINTED_AREA.exec(t.text);
      if (area) printedAreas.set(name, { value: Number(area[1].replace(/,/g, '')), text: t.text });
      if (part === null) note(sheetTitles, name, size);
      else {
        if (!partTitles.has(part)) partTitles.set(part, new Map());
        note(partTitles.get(part)!, name, size);
      }
    } else if (part !== null && foyer) {
      views[part].foyerLabel = t.text.trim();
    }
  }
  // Plans often print a hall's name in its foyer, by the entrance: a title in a part marked as
  // a foyer names the hall beside it.
  for (const [part, titles] of [...partTitles]) {
    if (!views[part].foyerLabel) continue;
    let target: number | null = null;
    let best = Infinity;
    for (const v of views) {
      if (v.noise || v.foyerLabel || v.id === part) continue;
      const g = parts.gaps.get(gapKey(part, v.id));
      if (g !== undefined && g * mpu <= FOYER_REACH && g < best) [target, best] = [v.id, g];
    }
    if (target === null) continue;
    if (!partTitles.has(target)) partTitles.set(target, new Map());
    for (const [name, size] of titles) note(partTitles.get(target)!, name, size);
    partTitles.delete(part);
  }
  // On each part, only the largest titles count: a smaller one names a neighbour.
  for (const [part, titles] of partTitles) {
    const largest = Math.max(...titles.values());
    views[part].titles = [...titles].filter(([, size]) => size >= 0.85 * largest).map(([n]) => n);
  }
  // The sheet's title: the largest hall title off the floor, when one stands out.
  const sheetTitle = (() => {
    const ranked = [...sheetTitles].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return '';
    if (ranked.length > 1 && ranked[1][1] >= 0.9 * ranked[0][1]) return '';
    return ranked[0][0];
  })();

  // Halls anchored by titles.
  type Draft = Omit<DetectedHall, 'key'> & { anchor: number };
  const drafts = new Map<string, Draft>();
  const assign = (part: number, hall: string, role: PartRole, by: PartView['by']) => {
    views[part].assignment = { hall, role };
    views[part].by = by;
  };
  const byName = new Map<string, string>();
  for (const v of views) {
    if (v.noise || !v.titles.length || (v.foyerLabel && !v.titles.length)) continue;
    const name = v.titles.join(' / ');
    let hallKey = byName.get(name);
    if (!hallKey) {
      hallKey = `${sheet.page}:${v.id}`;
      byName.set(name, hallKey);
      drafts.set(hallKey, {
        page: sheet.page,
        name,
        nameFrom: 'plan',
        parts: [],
        printedArea: v.titles.length === 1 ? (printedAreas.get(v.titles[0]) ?? null) : null,
        issues:
          v.titles.length > 1
            ? [
                {
                  id: 'separation',
                  severity: 'block',
                  message: `One piece of floor carries ${v.titles.length} hall titles (${v.titles.join(', ')}). The plan draws no boundary between them: cut it into one part per hall.`,
                },
              ]
            : [],
        duplicateOf: null,
        anchor: v.id,
      });
    }
    assign(v.id, hallKey, 'floor', 'title');
  }

  // Untitled pieces: one touching a single hall is that hall's floor (a line crossed it).
  const gap = (a: number, b: number) => parts.gaps.get(gapKey(a, b));
  const regionOf = (id: number) => parts.parts[id].region;
  /**
   * Halls whose floor lies within `reach` metres of a part. With `sameGrid`, only floor drawn on
   * the same grid counts: a piece on a shifted grid was drawn as a separate space.
   */
  const hallsNear = (part: number, reach: number, sameGrid = false) => {
    const out = new Map<string, number>();
    for (const v of views) {
      const g = v.assignment?.hall ? gap(part, v.id) : undefined;
      if (g === undefined || g * mpu > reach) continue;
      if (sameGrid && regionOf(v.id) !== regionOf(part)) continue;
      const hall = v.assignment!.hall!;
      out.set(hall, Math.min(out.get(hall) ?? Infinity, g));
    }
    return out;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const v of views) {
      if (v.noise || v.assignment || v.foyerLabel) continue;
      const near = hallsNear(v.id, SAME_FLOOR_GAP, true);
      if (near.size === 1) {
        assign(v.id, [...near.keys()][0], 'floor', 'touching');
        changed = true;
      } else if (near.size > 1) {
        v.candidates = [...near.keys()];
      }
    }
  }

  // A sheet titled for one hall, with no title on any piece: its largest piece is that hall.
  if (!drafts.size) {
    const largest = views.filter((v) => !v.noise).sort((a, b) => b.area - a.area)[0];
    if (largest) {
      const hallKey = `${sheet.page}:${largest.id}`;
      const name = sheetTitle;
      drafts.set(hallKey, {
        page: sheet.page,
        name,
        nameFrom: name ? 'sheet-title' : 'none',
        parts: [],
        printedArea: name ? (printedAreas.get(name) ?? null) : null,
        issues: [],
        duplicateOf: null,
        anchor: largest.id,
      });
      assign(largest.id, hallKey, 'floor', 'layout');
      for (let changed = true; changed;) {
        changed = false;
        for (const v of views) {
          if (v.noise || v.assignment || v.foyerLabel) continue;
          if (hallsNear(v.id, SAME_FLOOR_GAP, true).size === 1) {
            assign(v.id, hallKey, 'floor', 'touching');
            changed = true;
          }
        }
      }
    }
  }

  // Foyers: by the hall their label names, else the one hall they are beside.
  const hallTags = new Map([...drafts].map(([k, d]) => [hallTag(d.name || '?'), k]));
  for (const v of views) {
    if (v.noise || v.assignment) continue;
    const near = hallsNear(v.id, FOYER_REACH);
    if (v.foyerLabel) {
      const tag = FOYER.exec(v.foyerLabel)?.[2]?.replace(/\s+/g, '').toUpperCase();
      // "FOYER 5G" serves Hall 5 (G: its ground floor).
      const named = tag
        ? (hallTags.get(tag) ??
          [...hallTags].find(
            ([t]) => tag.startsWith(t) && /^[GF]{1,2}$/.test(tag.slice(t.length)),
          )?.[1])
        : undefined;
      if (named) {
        assign(v.id, named, 'foyer', 'foyer-label');
      } else if (near.size === 1) {
        assign(v.id, [...near.keys()][0], 'foyer', 'foyer-label');
      } else {
        v.candidates = [...near.keys()];
      }
      continue;
    }
    // Untitled and unlabelled, beside one hall and much smaller: most likely its foyer.
    if (near.size === 1) {
      const hall = [...near.keys()][0];
      const hallArea = views
        .filter((o) => o.assignment?.hall === hall && o.assignment.role === 'floor')
        .reduce((n, o) => n + o.area, 0);
      if (v.area < FOYER_SHARE * hallArea) assign(v.id, hall, 'foyer', 'layout');
    } else if (near.size > 1) {
      v.candidates = [...near.keys()];
    }
  }

  // Untitled pieces on their own: a hall each when they are hall-sized, without a name to
  // invent. Smaller ones (corridors, stores) stay unassigned for the person to place.
  const largest = Math.max(0, ...views.filter((v) => !v.noise).map((v) => v.area));
  for (const v of views) {
    if (v.noise || v.assignment || v.candidates.length) continue;
    if (v.area < UNTITLED_HALL_SHARE * largest) continue;
    const hallKey = `${sheet.page}:${v.id}`;
    drafts.set(hallKey, {
      page: sheet.page,
      name: '',
      nameFrom: 'none',
      parts: [],
      printedArea: null,
      issues: [],
      duplicateOf: null,
      anchor: v.id,
    });
    assign(v.id, hallKey, v.foyerLabel ? 'foyer' : 'floor', 'layout');
  }

  // The person's decisions win.
  const mine = overrides.assign[sheet.page] ?? {};
  for (const [id, decision] of Object.entries(mine)) {
    const v = views[Number(id)];
    if (!v) continue;
    v.assignment = decision.hall ? decision : null;
    v.by = 'you';
    v.candidates = [];
    if (decision.hall && !drafts.has(decision.hall)) {
      drafts.set(decision.hall, {
        page: sheet.page,
        name: '',
        nameFrom: 'none',
        parts: [],
        printedArea: null,
        issues: [],
        duplicateOf: null,
        anchor: v.id,
      });
    }
  }

  // Undecided pieces between halls: each of those halls must say whether they are its own.
  const undecided = views.filter((v) => !v.noise && !v.assignment && v.candidates.length);

  const halls: DetectedHall[] = [];
  for (const [hallKey, d] of drafts) {
    const members = views.filter((v) => v.assignment?.hall === hallKey);
    if (!members.length) continue;
    const issues = [...d.issues];
    for (const u of undecided.filter((x) => x.candidates.includes(hallKey))) {
      issues.push({
        id: `shared-${u.id}`,
        severity: 'block',
        message: `${u.foyerLabel ?? 'A piece of floor'} (${Math.round(m2(u.area * parts.sub * parts.sub))} m²) lies between ${u.candidates.length} halls. Assign it to one hall, or leave it in none.`,
      });
    }
    for (const v of members) {
      if (v.by === 'touching') {
        const g = Math.min(
          ...members.filter((o) => o.id !== v.id).map((o) => gap(v.id, o.id) ?? Infinity),
        );
        if (g > 0 && Number.isFinite(g)) {
          issues.push({
            id: `joined-${v.id}`,
            severity: 'note',
            message: `An untitled piece (${Math.round(m2(v.area * parts.sub * parts.sub))} m²) on the same grid is joined to this hall across a ${(g * mpu).toFixed(1)} m gap. Check that it is this hall's floor.`,
          });
        }
      }
      if (v.by === 'layout' && v.assignment?.role === 'foyer') {
        issues.push({
          id: `foyer-${v.id}`,
          severity: 'note',
          message: `An untitled piece beside the hall (${Math.round(m2(v.area * parts.sub * parts.sub))} m²) is taken as its foyer from the layout alone. Check it.`,
        });
      }
    }
    const name = overrides.names[hallKey] ?? d.name;
    halls.push({
      key: hallKey,
      page: d.page,
      name,
      nameFrom: overrides.names[hallKey] ? 'you' : d.nameFrom,
      parts: members.map((v) => ({
        id: v.id,
        role: v.assignment!.role,
        inferred: v.by === 'layout' || v.by === 'touching',
      })),
      printedArea: d.printedArea ?? printedAreas.get(name) ?? null,
      issues,
      duplicateOf: null,
    });
  }
  return { page: sheet.page, halls, parts: views };
}

/** Marks halls found again on a later page (a repeated view of the same hall). */
export function markDuplicates(
  sheets: SheetHalls[],
  grossArea: (hall: DetectedHall) => number,
): void {
  const seen: DetectedHall[] = [];
  for (const sheet of sheets) {
    for (const hall of sheet.halls) {
      const twin = seen.find(
        (s) =>
          s.page !== hall.page &&
          s.name &&
          s.name === hall.name &&
          Math.abs(grossArea(s) - grossArea(hall)) <=
            0.05 * Math.max(grossArea(s), grossArea(hall)),
      );
      if (twin) {
        hall.duplicateOf = twin.key;
        hall.issues.push({
          id: 'duplicate',
          severity: 'block',
          message: `The same hall as on page ${twin.page} (same name and size). Save it only if it is a different floor.`,
        });
      }
      seen.push(hall);
    }
  }
}

/** The part a text lies in, else the nearest within reach (beside it, ideally in line with it). */
function partAt(
  t: AnalysedText,
  parts: SheetParts,
  views: PartView[],
  reach: number,
  insideOnly = false,
): number | null {
  const cx = t.x + t.width / 2;
  const cy = t.y + t.height / 2;
  const mx = Math.floor(cx * parts.sub);
  const my = Math.floor(cy * parts.sub);
  if (mx >= 0 && my >= 0 && mx < parts.cols && my < parts.rows) {
    const inside = parts.partOf[my * parts.cols + mx];
    if (inside >= 0 && !views[inside].noise) return inside;
  }
  if (insideOnly) return null;
  let best: number | null = null;
  let bestScore = Infinity;
  for (const v of views) {
    if (v.noise) continue;
    const dx = Math.max(v.x - cx, 0, cx - (v.x + v.width));
    const dy = Math.max(v.y - cy, 0, cy - (v.y + v.height));
    const d = Math.hypot(dx, dy);
    if (d > reach) continue;
    // A title in line with a hall (printed under or beside it) beats a nearer diagonal one.
    const inLine = dx === 0 || dy === 0;
    const score = inLine ? d : d * 2;
    if (score < bestScore) [best, bestScore] = [v.id, score];
  }
  return best;
}

const key = (text: string) => text.replace(/\s+/g, ' ').trim();
