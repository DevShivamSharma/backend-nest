import { analyseDrawing, HallDraft } from './cad/hall-analysis';
import type { CadDrawing } from './cad/cad-drawing';
import type { AreaKind, MultiPolygon, PlanPage, PlanRegion, Point } from './plan.types';
import {
  area,
  bounds,
  difference,
  geometryProblems,
  intersection,
  rectangle,
  union,
} from './geometry';

const identity = (name: string) =>
  /\bhalls?\s*[-–:#]?\s*(\d+\s*[a-e]?)/i.exec(name)?.[1].replace(/\s/g, '').toLowerCase();

/** Reuse main's CAD hall/grid splitter while keeping source coordinates and POC review gates. */
export function enhanceWithCad(page: PlanPage, drawing?: CadDrawing): PlanPage {
  if (
    !drawing?.metresPerUnit ||
    !drawing.layers.some((l) =>
      /^(?:stall[ _-]*)?grid(?:[ _-]*lines)?$/i.test(l.split(/\$0\$|\|/).pop()!),
    )
  )
    return page;
  try {
    // Main's floor tracing expects a square lattice; retain the generic proposals for
    // rectangular grids rather than distorting the source to fit that assumption.
    if (
      drawing.gridCell &&
      Math.abs(drawing.gridCell.width - drawing.gridCell.height) > drawing.gridCell.width * 0.02
    )
      return page;
    const result = analyseDrawing(drawing, 'Floor plan.pdf');
    if (!result.scale.known || !result.overview.sourceOrigin) return page;
    const sourceHalls = page.regions.filter((r) => r.role === 'hall');
    const drafts = (result.multiHall ? result.candidates : result.candidates.slice(0, 1)).sort(
      (a, b) =>
        sourceHalls.findIndex((r) => identity(r.name) === identity(a.name)) -
        sourceHalls.findIndex((r) => identity(r.name) === identity(b.name)),
    );
    // The generic reader already excludes adjacent-hall directions and area-table labels.
    // Compare occupied hall identities, not every "HALL" caption elsewhere on the sheet.
    const expected = new Set(sourceHalls.map((r) => identity(r.name)).filter(Boolean));
    if (
      !expected.size ||
      drafts.length !== expected.size ||
      drafts.some((d) => !expected.has(identity(d.name)))
    ) {
      page.warnings.push(
        'CAD and image hall identities disagree; the image proposals are retained for review.',
      );
      return page;
    }
    const s = result.scale.metresPerUnit,
      origin = result.overview.sourceOrigin;
    const point = (draft: HallDraft, p: { x: number; z: number }): Point => [
      origin[0] + (draft.origin.x + p.x) / s,
      page.height - origin[1] + (draft.origin.z + p.z) / s,
    ];
    const polygon = (draft: HallDraft, ring: { x: number; z: number }[]): MultiPolygon => {
      const out = ring.map((p) => point(draft, p));
      return out.length ? [[[...out, out[0]]]] : [];
    };
    const full = drafts.map((d) =>
      union(...(d.floorRegions ?? [d.boundary]).map((r) => polygon(d, r))),
    );
    if (full.some((g) => geometryProblems(g).length)) return page;
    const halls: PlanRegion[] = drafts.map((d, i) => {
      const previous = sourceHalls.find((r) => identity(r.name) === identity(d.name));
      const b = bounds(full[i]);
      return {
        id: previous?.id ?? `p${page.number}-cad-hall-${i + 1}`,
        name: previous?.name ?? d.name,
        role: 'hall',
        geometry: full[i],
        hallIds: [],
        confirmed: false,
        restrictionsConfirmed: false,
        printedArea: previous?.printedArea ?? null,
        grid: drawing.gridCell
          ? {
              x: b.x,
              y: b.y,
              width: drawing.gridCell.width / s,
              height: drawing.gridCell.height / s,
              rotation: 0,
            }
          : (previous?.grid ?? page.grid),
      };
    });
    // Explicit foyer/circulation proposals are cut against the CAD floor and kept as zones.
    // Their footprint is removed from hall interiors so a detected zone cannot block saving
    // merely because the original grid-envelope proposal included that same footprint.
    const zones = page.regions
      .filter((r) => r.role === 'foyer' || r.role === 'circulation')
      .flatMap((zone) => {
        const owners = halls.filter((h) => zone.hallIds.includes(h.id));
        if (!owners.length) return [zone];
        // A detached foyer can sit outside the main building outline. Preserve its source
        // footprint instead of dropping it when main's hall candidate does not cover it.
        const grid = zone.grid ?? owners[0].grid;
        return [
          {
            ...zone,
            confirmed: false,
            grid:
              grid && drawing.gridCell
                ? {
                    ...grid,
                    width: drawing.gridCell.width / s,
                    height: drawing.gridCell.height / s,
                  }
                : grid,
          },
        ];
      });
    halls.forEach((h) => {
      // Source circulation between two halls is a separate area even when its provisional
      // owner is only one hall. Remove that footprint from every hall interior; ownership
      // controls which saved hall receives the zone and remains a separate review step.
      h.geometry = difference(h.geometry, ...zones.map((z) => z.geometry));
    });
    if (halls.some((h) => geometryProblems(h.geometry).length)) return page;
    const objects: PlanPage['objects'] = [];
    const allFloors = union(...full, ...zones.map((z) => z.geometry));
    const add = (
      kind: AreaKind,
      label: string,
      color: string,
      geometry: MultiPolygon,
      detail: string,
      source: 'legend' | 'geometry' = 'legend',
    ) => {
      if (geometryProblems(geometry).length || area(intersection(geometry, allFloors)) < 1e-8)
        return;
      if (objects.length >= 1000) throw new Error('More than 1000 CAD restrictions require review');
      objects.push({
        id: `p${page.number}-cad-object-${objects.length + 1}`,
        kind,
        label,
        color,
        geometry,
        confirmed: false,
        evidence: { source, detail },
      });
    };
    drafts.forEach((d) => {
      d.blockedAreas
        .filter((a) => a.kind !== 'outside')
        .forEach((a) => {
          const p = point(d, { x: a.posX, z: a.posZ });
          const kind = a.kind === 'wall' ? 'wall' : 'column';
          add(
            kind,
            a.title ?? kind,
            a.color,
            rectangle(
              p[0] - a.width / (2 * s),
              p[1] - a.length / (2 * s),
              a.width / s,
              a.length / s,
            ),
            `CAD ${kind === 'column' ? 'column layer' : 'grid-floor perimeter'}`,
            'geometry',
          );
        });
      const kinds: Record<string, AreaKind> = {
        SMOKE_CURTAIN: 'fire_curtain',
        NO_CONSTRUCTION: 'no_build',
        PASSAGE: 'passage',
        EMERGENCY_EXIT_ACCESS: 'passage',
        ENTRY_EXIT_ACCESS: 'passage',
        FACILITY_ACCESS: 'passage',
        FOYER: 'passage',
        PARTITION: 'wall',
      };
      d.zones.forEach((z) =>
        add(
          kinds[z.kind],
          z.label,
          z.color ?? '#777777',
          polygon(d, z.polygon),
          'Meaning from CAD layer or plan legend: ' + z.label,
        ),
      );
    });
    const unrecognised = page.objects.filter(
      (o) =>
        !objects.some(
          (known) => area(intersection(o.geometry, known.geometry)) >= area(o.geometry) * 0.8,
        ),
    );
    const updated: PlanPage = {
      ...page,
      regions: [...halls, ...zones, ...page.regions.filter((r) => r.role === 'exclude')],
      objects: [...objects, ...unrecognised],
      annotations: drafts.flatMap((d, i) =>
        d.amenities.map((a, j) => ({
          id: `p${page.number}-cad-annotation-${i + 1}-${j + 1}`,
          type: 'facility' as const,
          text: a.label,
          kind: a.kind,
          anchor: point(d, a.position),
          regionIds: [halls[i].id],
          confirmed: true,
          evidence: {
            source: a.source === 'label' ? ('text' as const) : ('geometry' as const),
            detail: `CAD ${a.source}: ${a.label}`,
          },
        })),
      ),
      calibration: { metresPerUnit: s, source: drawing.scaleSource, confirmed: true },
      grid: halls[0].grid,
      legend: result.candidates[0].legends.map((l) => ({
        label: l.label,
        color: l.colorCode ?? null,
      })),
      warnings: [
        ...page.warnings.filter(
          (w) => !w.includes('Detected X/Y grid pitches disagree') && !w.includes('envelopes'),
        ),
        'CAD grid boundaries and restrictions analysed using the main-branch engine; inspect each hall and foyer before saving.',
      ],
    };
    if (updated.objects.length > 1000)
      throw new Error('More than 1000 source restrictions require review');
    return updated;
  } catch (error) {
    page.warnings.push(
      `CAD boundary analysis could not finish: ${error instanceof Error ? error.message : 'unknown error'}. Image proposals remain available.`,
    );
    return page;
  }
}
