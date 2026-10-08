import { classifyLabel } from './cad/hall-analysis';
import { area, bounds, inside, intersection, rectangle } from './geometry';
import type { MultiPolygon, PlanAnnotation, PlanPage, Point } from './plan.types';
import type { HallFloor, FloorRect } from '../floor/hall-floor';

const gateCode = /^(?:EE|GG|TH|TG|S|E|T)[ -]?\d[\w/-]{1,22}$/i;
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function project(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return [a[0] + t * dx, a[1] + t * dy];
}
function edgeDistance(p: Point, geometry: MultiPolygon) {
  if (inside(p, geometry)) return 0;
  return Math.min(
    ...geometry.flatMap((poly) =>
      poly[0].slice(1).map((b, i) => distance(p, project(p, poly[0][i], b))),
    ),
  );
}

/** Text is used as evidence; dimensions, stall codes and legend-table examples are not cards. */
export function detectAnnotations(page: PlanPage): PlanAnnotation[] {
  const regions = page.regions.filter((r) => r.role !== 'exclude');
  const cell = page.grid?.width ?? Math.max(page.width, page.height) / 100;
  const headings = page.texts.filter((t) => /^legend\b/i.test(t.text));
  const inLegend = (x: number, y: number) =>
    headings.some(
      (h) =>
        x >= h.x - h.height * 4 &&
        x <= h.x + Math.max(h.width, h.height * 55) &&
        y >= h.y - h.height &&
        y <= h.y + h.height * 25,
    );
  const found = (page.annotations ?? []).filter((a) => !inLegend(...a.anchor));
  for (const t of page.texts) {
    const anchor: Point = [t.x + t.width / 2, t.y + t.height / 2];
    if (inLegend(...anchor) || t.confidence < 0.55) continue;
    const facility = classifyLabel(t.text);
    if (!facility && !gateCode.test(t.text.trim())) continue;
    // Direction captions are navigation text, rather than a physical entry in this hall.
    if (/\b(?:from|to)\s+(?:hall|gate)|\bhalls?\s*\d.*\b(?:entry|exit)/i.test(t.text)) continue;
    const nearest = regions
      .map((r) => ({ r, d: edgeDistance(anchor, r.geometry) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!nearest || nearest.d > cell * 20) continue;
    if (!facility && inside(anchor, nearest.r.geometry) && nearest.d === 0) {
      // An entry code deep inside the floor can be a stall identifier.
      const outer = nearest.r.geometry.flatMap((p) =>
        p[0].slice(1).map((b, i) => distance(anchor, project(anchor, p[0][i], b))),
      );
      if (Math.min(...outer) > cell * 3) continue;
    }
    const text = facility?.label ?? t.text.trim();
    const kind = facility?.kind ?? null;
    if (
      found.some(
        (a) =>
          a.kind === kind &&
          a.text.toLowerCase() === text.toLowerCase() &&
          distance(a.anchor, anchor) < cell * 4,
      )
    )
      continue;
    found.push({
      id: `p${page.number}-annotation-${found.length + 1}`,
      type: facility ? 'facility' : 'label',
      text,
      kind,
      anchor,
      regionIds: [nearest.r.id],
      confirmed: t.confidence >= 0.8,
      evidence: { source: 'text', detail: `Source ${t.source} text: ${t.text}` },
    });
    if (found.length >= 500) break;
  }
  return found;
}

/** Place complete annotation boxes outside the floor polygons and outside each other. */
export function layoutAnnotations(
  page: PlanPage,
  hallId: string,
  boundary: MultiPolygon,
  scale: number,
  origin: Point,
): Pick<HallFloor, 'labels' | 'iconGroups'> {
  const ids = new Set([
    hallId,
    ...page.regions.filter((r) => r.hallIds.includes(hallId)).map((r) => r.id),
  ]);
  const local = (p: Point): Point => [(p[0] - origin[0]) * scale, (p[1] - origin[1]) * scale];
  // Each saved hall has its own coordinate frame and its attached foyer/circulation grids.
  const allGrid = boundary;
  const b = bounds(boundary),
    font = Math.max(0.6, Math.min(1.4, Math.max(b.width, b.height) * 0.011));
  const margin = font * 1.2,
    occupied: FloorRect[] = [];
  const overlaps = (r: FloorRect) =>
    occupied.some(
      (o) =>
        r.x < o.x + o.width + margin &&
        r.x + r.width + margin > o.x &&
        r.y < o.y + o.height + margin &&
        r.y + r.height + margin > o.y,
    );
  const valid = (r: FloorRect) =>
    !overlaps(r) && area(intersection(rectangle(r.x, r.y, r.width, r.height), allGrid)) < 1e-7;
  const place = (anchor: Point, width: number, height: number): FloorRect => {
    const edges = boundary
      .flatMap((poly) =>
        poly[0].slice(1).map((end, i) => {
          const start = poly[0][i],
            p = project(anchor, start, end);
          const length = distance(start, end) || 1;
          let nx = (end[1] - start[1]) / length,
            ny = -(end[0] - start[0]) / length;
          if (inside([p[0] + nx * margin, p[1] + ny * margin], boundary)) {
            nx = -nx;
            ny = -ny;
          }
          return { p, nx, ny, d: distance(anchor, p) };
        }),
      )
      .sort((a, z) => a.d - z.d);
    for (const e of edges) {
      for (const lane of [1, 2, 3]) {
        for (const shift of [0, 1, -1, 2, -2]) {
          const offset = margin * lane + (Math.abs(e.nx) * width + Math.abs(e.ny) * height) / 2;
          const r = {
            x: e.p[0] + e.nx * offset - e.ny * shift * (width + margin) - width / 2,
            y: e.p[1] + e.ny * offset + e.nx * shift * (height + margin) - height / 2,
            width,
            height,
          };
          if (valid(r)) {
            occupied.push(r);
            return r;
          }
        }
      }
    }
    // Crowded local edges use exterior lanes instead of falling back onto the grid.
    const whole = bounds(allGrid);
    let r = { x: whole.x + whole.width + margin, y: whole.y, width, height };
    while (overlaps(r)) r = { ...r, y: r.y + height + margin };
    occupied.push(r);
    return r;
  };
  const labels: HallFloor['labels'] = [],
    iconGroups: HallFloor['iconGroups'] = [];
  const annotations = (page.annotations ?? []).filter(
    (a) => a.confirmed && a.regionIds.some((id) => ids.has(id)),
  );
  const groups: { anchor: Point; icons: HallFloor['iconGroups'][number]['icons'] }[] = [];
  for (const a of annotations.filter((a) => a.type === 'facility')) {
    const anchor = local(a.anchor);
    let group = groups.find((g) => distance(g.anchor, anchor) <= Math.max(8, font * 7));
    if (!group) {
      group = { anchor, icons: [] };
      groups.push(group);
    }
    if (!group.icons.some((i) => i.kind === a.kind && i.label === a.text))
      group.icons.push({ kind: a.kind ?? 'facility', label: a.text });
  }
  for (const g of groups)
    iconGroups.push({ ...place(g.anchor, font * 9 * g.icons.length, font * 4.5), icons: g.icons });
  const caption = (text: string, anchor: Point) =>
    labels.push({ text, ...place(anchor, font * (text.length * 0.58 + 1), font * 1.7) });
  for (const a of annotations.filter((a) => a.type === 'label')) caption(a.text, local(a.anchor));
  for (const r of page.regions.filter((r) => ids.has(r.id))) {
    const box = bounds(r.geometry);
    caption(r.name, local([box.x + box.width / 2, r.role === 'hall' ? box.y + box.height : box.y]));
  }
  return { labels, iconGroups };
}
