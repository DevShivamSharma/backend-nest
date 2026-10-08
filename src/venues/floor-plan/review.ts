import { blankFloor, floorProblems, blocksStalls, type HallFloor } from '../floor/hall-floor';
import { layoutAnnotations } from './annotations';
import {
  area,
  bounds,
  difference,
  geometryProblems,
  intersection,
  orthogonalRectangles,
  rectangle,
  transform,
  union,
} from './geometry';
import type {
  FloorGeometry,
  MultiPolygon,
  PlanCheck,
  PlanPage,
  PlanRegion,
  PlanReview,
  Point,
} from './plan.types';

export const hallKey = (page: number, id: string) => `${page}:${id}`;
export function reviewHall(
  documentId: string,
  revision: number,
  page: PlanPage,
  hall: PlanRegion,
  acknowledgements: string[] = [],
): { review: PlanReview; floor: HallFloor | null } {
  const key = hallKey(page.number, hall.id),
    checks: PlanCheck[] = [];
  const check = (
    id: string,
    label: string,
    ok: boolean | null,
    detail: string,
    overridable = false,
    extra: Partial<PlanCheck> = {},
  ) =>
    checks.push({
      id: `${key}:${id}`,
      label,
      status: ok === null ? 'unknown' : ok ? 'pass' : 'fail',
      detail,
      blocking: true,
      overridable,
      ...extra,
    });
  const scale = page.calibration.metresPerUnit;
  check(
    'scale',
    'Metric scale',
    !!scale && scale > 0 && page.calibration.confirmed,
    page.calibration.source,
  );
  check(
    'boundary',
    'Hall boundary reviewed',
    hall.confirmed,
    'Trace the complete hall boundary, including edge cells.',
  );
  check(
    'restrictions',
    'Restrictions and facilities reviewed',
    !!hall.restrictionsConfirmed,
    'Check columns, fire curtains, passages, exits and facilities against the source.',
  );
  const zones = page.regions.filter(
    (r) => (r.role === 'foyer' || r.role === 'circulation') && r.hallIds.includes(hall.id),
  );
  check(
    'zones',
    'Foyer ownership reviewed',
    zones.every((z) => z.confirmed),
    'Confirm each attached foyer and its hall links.',
  );
  const unmatched = page.regions.filter(
    (r) => (r.role === 'foyer' || r.role === 'circulation') && !r.hallIds.length,
  );
  check(
    'unassigned',
    'Unassigned foyers',
    !unmatched.length,
    unmatched.map((r) => r.name).join(', ') || 'All detected foyers have an owner.',
    true,
  );
  const grid = hall.grid ?? page.grid;
  check(
    'grid',
    'Grid pitch established',
    !!grid && grid.width > 0 && grid.height > 0,
    'Set pitch and origin using the source grid or a reviewed design grid.',
  );
  check(
    'square',
    'Square grid',
    grid ? Math.abs(grid.width - grid.height) / Math.max(grid.width, grid.height) <= 0.02 : null,
    'X and Y pitches should agree within 2%; acknowledge only if the source intentionally uses rectangular cells.',
    true,
  );
  const note = page.texts.find((t) => /grid.*(?:size|spacing|cell)/i.test(t.text))?.text;
  const values = note?.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|ft)\b/i,
  );
  if (values) {
    const units: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048 };
    const x = Number(values[1]) * units[values[2] ?? values[4]],
      y = Number(values[3]) * units[values[4]];
    check(
      'grid-note',
      'Printed grid size',
      grid && scale
        ? Math.abs(grid.width * scale - x) <= 0.02 * x &&
            Math.abs(grid.height * scale - y) <= 0.02 * y
        : null,
      note!,
      true,
    );
  }
  const hallArea = scale ? area(hall.geometry) * scale * scale : 0;
  check(
    'area',
    'Printed hall area',
    hall.printedArea && scale
      ? Math.abs(hallArea - hall.printedArea) <= Math.max(0.5, hall.printedArea * 0.005)
      : null,
    hall.printedArea
      ? 'Measured boundary area compared to the printed area (0.5%).'
      : 'No printed hall area has been linked. Confirm that it is unavailable or add it.',
    true,
    {
      expected: hall.printedArea ?? undefined,
      measured: hallArea,
      tolerance: hall.printedArea ? Math.max(0.5, hall.printedArea * 0.005) : undefined,
    },
  );
  const dims = page.dimensions.filter((d) => d.regionId === hall.id || d.regionId === null);
  check(
    'dimensions',
    'Source dimensions linked',
    dims.length > 0,
    'Add independent dimension checks or acknowledge that the source has no dimensions.',
    true,
  );
  for (const d of dims) {
    const measured = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * (scale ?? 0);
    check(
      'dim-' + d.id,
      d.label,
      d.confirmed && !!scale ? Math.abs(measured - d.metres) <= 0.5 : null,
      'Tolerance ±0.5 m.',
      true,
      { expected: d.metres, measured, tolerance: 0.5 },
    );
  }
  for (const other of page.regions.filter((r) => r.role === 'hall' && r.id !== hall.id))
    check(
      'overlap-' + other.id,
      `Separate from ${other.name}`,
      area(intersection(hall.geometry, other.geometry)) < 1e-5,
      'Hall interiors must not overlap. Shared areas belong in a foyer or circulation zone.',
    );
  for (const zone of zones) {
    check(
      'zone-overlap-' + zone.id,
      `${zone.name} boundary`,
      page.regions
        .filter((r) => r.role === 'hall')
        .every((r) => area(intersection(zone.geometry, r.geometry)) < 1e-5),
      'A foyer must not overlap a hall interior; edit its boundary.',
    );
    if (zone.printedArea && scale) {
      const measured = area(zone.geometry) * scale * scale;
      check(
        'zone-area-' + zone.id,
        `${zone.name} printed area`,
        Math.abs(measured - zone.printedArea) <= Math.max(0.5, zone.printedArea * 0.005),
        'Compared with source area.',
        true,
        { expected: zone.printedArea, measured },
      );
    }
  }
  const boundary = union(hall.geometry, ...zones.map((z) => z.geometry));
  const objects = page.objects.filter((o) => area(intersection(o.geometry, boundary)) > 1e-8);
  check(
    'objects',
    'Area meanings confirmed',
    objects.every((o) => o.confirmed && o.kind !== 'unknown'),
    'Every source shape must have a reviewed meaning. Colour alone does not establish use.',
  );
  let floor: HallFloor | null = null,
    drawableArea = 0,
    foyerArea = 0;
  if (scale && scale > 0 && grid) {
    const b = bounds(boundary),
      local = (p: Point): Point => [(p[0] - b.x) * scale, (p[1] - b.y) * scale];
    const geometry: FloorGeometry = {
      schema: 'geometry/1',
      unit: 'm',
      boundary: transform(boundary, local),
      hallBoundary: transform(hall.geometry, local),
      grid: {
        ...grid,
        x: (grid.x - b.x) * scale,
        y: (grid.y - b.y) * scale,
        width: grid.width * scale,
        height: grid.height * scale,
      },
      objects: objects
        .filter((o) => o.confirmed && o.kind !== 'unknown')
        .map((o) => ({
          id: o.id,
          kind: o.kind as Exclude<typeof o.kind, 'unknown'>,
          label: o.label,
          color: o.color,
          geometry: transform(intersection(o.geometry, boundary), local),
          blocksStalls: o.kind !== 'marking',
          evidence: o.evidence,
        })),
      zones: zones.map((z) => ({
        id: `${documentId}:${page.number}:${z.id}`,
        name: z.name,
        kind: z.role as 'foyer' | 'circulation',
        geometry: transform(z.geometry, local),
        grid: {
          ...(z.grid ?? grid),
          x: ((z.grid ?? grid).x - b.x) * scale,
          y: ((z.grid ?? grid).y - b.y) * scale,
          width: (z.grid ?? grid).width * scale,
          height: (z.grid ?? grid).height * scale,
        },
        shared: z.hallIds.length > 1,
        hallKeys: z.hallIds.map((id) => hallKey(page.number, id)),
      })),
      source: {
        documentId,
        page: page.number,
        regionId: hall.id,
        origin: [b.x, b.y],
        metresPerUnit: scale,
      },
      review: { revision, checks, acknowledgements },
    };
    floor = {
      ...blankFloor(b.width * scale, b.height * scale),
      ...layoutAnnotations(page, hall.id, geometry.boundary, scale, [b.x, b.y]),
      geometry,
      legend: page.legend.map((l) => ({
        label: l.label,
        ...(l.color ? { color: l.color } : {}),
        showInView: true,
      })),
      placement: {
        file: documentId,
        page: page.number,
        x: b.x * scale,
        y: b.y * scale,
        rotation: 0,
        gridMetres: grid.width * scale,
        scaleSource: page.calibration.source,
        source: { unit: 'source', x: b.x, y: b.y },
      },
    };
    foyerArea = area(
      union(...geometry.zones.filter((z) => z.kind === 'foyer').map((z) => z.geometry)),
    );
    drawableArea = area(drawable(floor));
    const problems = [
      ...floorProblems(floor),
      ...geometryProblems(hall.geometry),
      ...zones.flatMap((z) => geometryProblems(z.geometry)),
    ];
    check(
      'geometry',
      'Valid geometry and size',
      !problems.length,
      problems.join(' ') || 'Geometry can be saved without losing source coordinates.',
    );
  }
  return {
    floor,
    review: {
      key,
      page: page.number,
      regionId: hall.id,
      name: hall.name,
      width: floor?.width ?? 0,
      depth: floor?.depth ?? 0,
      hallArea,
      foyerArea,
      drawableArea,
      checks,
      ready:
        !!floor &&
        checks.every(
          (c) => c.status === 'pass' || (c.overridable && acknowledgements.includes(c.id)),
        ),
      savedHallId: null,
      existing: [],
    },
  };
}
export function drawable(floor: HallFloor): MultiPolygon {
  if (floor.geometry)
    return difference(
      floor.geometry.boundary,
      ...floor.geometry.objects.filter((o) => o.blocksStalls).map((o) => o.geometry),
    );
  return difference(
    rectangle(0, 0, floor.width, floor.depth),
    ...floor.areas
      .filter((a) => blocksStalls(a.kind))
      .map((a) => rectangle(a.x, a.y, a.width, a.height)),
  );
}
export function floorDiff(before: HallFloor, after: HallFloor) {
  const a = drawable(before),
    b = drawable(after),
    added = difference(b, a),
    removed = difference(a, b);
  return {
    added,
    removed,
    addedArea: area(added),
    removedArea: area(removed),
    iou: area(intersection(a, b)) / Math.max(area(union(a, b)), 1e-9),
    alignment: 'Local top-left origins; verify alignment before interpreting changes.',
  };
}
/** The geometry extension is authoritative. Never silently rasterise polygons into guessed rectangles. */
export function exportConfig(name: string, floor: HallFloor) {
  const g = floor.geometry;
  const integer = (n: number) => Math.abs(n - Math.round(n)) < 1e-7;
  let exact =
    !g ||
    (Math.abs(g.grid.rotation) < 1e-7 &&
      integer(g.grid.x / g.grid.width) &&
      integer(g.grid.y / g.grid.height) &&
      integer(floor.width / g.grid.width) &&
      integer(floor.depth / g.grid.height));
  const areas = [...floor.areas];
  if (g) {
    const outside = orthogonalRectangles(
      difference(rectangle(0, 0, floor.width, floor.depth), g.boundary),
    );
    if (outside)
      areas.push(...outside.map((r) => ({ ...r, kind: 'outside' as const, color: '#000000' })));
    else exact = false;
    for (const o of g.objects) {
      const rects = orthogonalRectangles(o.geometry);
      if (rects)
        areas.push(...rects.map((r) => ({ ...r, kind: o.kind, label: o.label, color: o.color })));
      else exact = false;
    }
  }
  const labels = floor.labels;
  return {
    header: { code: 200, error: false, success: true, msg: 'Success' },
    format: 'floor-plan-config/1',
    requiresGeometryRenderer: !exact,
    annotationPixelsPerMetre: 20,
    data: [
      {
        hallId: g?.source.regionId,
        name,
        length: floor.width,
        breadth: floor.depth,
        layout_data: {
          shape: 'non-circular',
          stallWidth: g?.grid.width ?? 1,
          stallHeight: g?.grid.height ?? 1,
          nonClickableAreas: areas.map((a) => ({
            x: a.x,
            y: a.y,
            width: a.width,
            height: a.height,
            title: a.label,
            kind: a.kind,
            fillColor: a.color ?? '#808080',
            strokeColor: a.color ?? '#808080',
            visibleInView: !a.hidden,
            visibleInMarking: true,
          })),
        },
        geometry: g,
        legends: floor.legend.map((l) => ({
          label: l.label,
          colorCode: l.color,
          visibleInViewMode: l.showInView,
        })),
        helper_text: floor.iconGroups.map((g) => ({
          positionX: g.x * 20,
          positionY: g.y * 20,
          image: g.icons.map((i) => ({ url: `assets/images/${i.kind}.svg`, label: i.label })),
        })),
        exit_labels: labels.map((l) => ({
          text: l.text,
          positionX: l.x * 20,
          positionY: l.y * 20,
        })),
        direction: null,
        default_stalls: [],
      },
    ],
  };
}
