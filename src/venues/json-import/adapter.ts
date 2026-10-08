import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  cleanColor,
  cleanText,
  finite,
  FLOOR_AREA_KINDS,
  FLOOR_SCHEMA,
  floorProblems,
  HallFloor,
  blocksStalls,
} from '../floor/hall-floor';
import {
  area,
  bounds,
  difference,
  geometryProblems,
  rectangle,
  transform,
  union,
} from '../floor-plan/geometry';
import type { AreaKind, FloorGeometry, MultiPolygon, Point } from '../floor-plan/plan.types';
import { itpoRowToFloor, readItpoHallRows } from '../../integrations/itpo/itpo-hall-layout';

type Obj = Record<string, any>;
export interface JsonMapping {
  halls?: string;
  name?: string;
  width?: string;
  depth?: string;
  boundary?: string;
  areas?: string;
  zones?: string;
  unit?: string;
  metresPerUnit?: number;
  kinds?: Record<string, string>;
  yAxis?: 'down' | 'up';
  areaFields?: Partial<
    Record<'x' | 'y' | 'width' | 'height' | 'kind' | 'label' | 'geometry', string>
  >;
}
export interface JsonRow {
  externalId: string;
  name: string;
  floor: HallFloor | null;
  warnings: string[];
  error: string | null;
  source: 'itpo' | 'json' | 'csv';
}
export interface JsonAdaptation {
  rows: JsonRow[];
  fields: string[];
  collectionPaths: string[];
  areaTypes: string[];
}
const obj = (v: any): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function at(v: any, path: string): any {
  if (!path || path === '$') return v;
  return path
    .replace(/^\$\./, '')
    .split('.')
    .reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), v);
}
function pick(v: any, ...names: string[]): any {
  if (!obj(v)) return undefined;
  const k = Object.keys(v).find((k) => names.some((n) => key(k) === key(n)));
  return k === undefined ? undefined : v[k];
}
function fields(v: any, base = '', depth = 0): string[] {
  if (!obj(v) || depth > 4) return [];
  return Object.keys(v)
    .slice(0, 100)
    .flatMap((k) => {
      const p = base ? `${base}.${k}` : k;
      return [p, ...fields(v[k], p, depth + 1)];
    });
}
function collections(v: any, base = '', depth = 0): string[] {
  if (!obj(v) || depth > 5) return [];
  return Object.entries(v)
    .slice(0, 100)
    .flatMap(([k, value]) => {
      const p = base ? `${base}.${k}` : k;
      return Array.isArray(value) ? [p] : collections(value, p, depth + 1);
    });
}
function unwrap(v: any, depth = 0): any {
  if (depth > 6 || Array.isArray(v) || !obj(v)) return v;
  if (
    v.schema === FLOOR_SCHEMA ||
    v.type === 'Feature' ||
    pick(v, 'width', 'length', 'boundary', 'layout_data') !== undefined
  )
    return v;
  const next = pick(
    v,
    'halls',
    'floors',
    'rooms',
    'layouts',
    'features',
    'data',
    'result',
    'payload',
  );
  return next !== undefined ? unwrap(next, depth + 1) : v;
}
const aliases: Record<string, AreaKind> = {
  pillar: 'column',
  columns: 'column',
  obstacle: 'no_build',
  restricted: 'no_build',
  restrictedarea: 'no_build',
  nobuild: 'no_build',
  noconstruction: 'no_build',
  corridor: 'passage',
  aisle: 'passage',
  exit: 'entry',
  entrance: 'entry',
  firecurtain: 'fire_curtain',
  electrical: 'utility',
  toilet: 'facility',
  stairs: 'facility',
  lift: 'facility',
  hole: 'void',
  outside: 'outside',
  annotation: 'marking',
  decoration: 'marking',
};
function kind(raw: any, m: JsonMapping): AreaKind {
  const token = String(raw ?? '');
  const value = m.kinds?.[token] ?? aliases[key(token)] ?? token.toLowerCase();
  if (!FLOOR_AREA_KINDS.includes(value as AreaKind))
    throw new Error(`Choose a meaning for area type "${token || '(missing)'}" in Area meanings.`);
  return value as AreaKind;
}
function scaleFor(row: Obj, root: Obj, m: JsonMapping): number {
  if (m.metresPerUnit !== undefined) {
    if (!(m.metresPerUnit > 0 && m.metresPerUnit <= 1000))
      throw new Error('Metres per source unit must be greater than 0 and at most 1000.');
    return m.metresPerUnit;
  }
  const units: Record<string, number> = {
    m: 1,
    metre: 1,
    metres: 1,
    meter: 1,
    meters: 1,
    mm: 0.001,
    millimeters: 0.001,
    millimetres: 0.001,
    cm: 0.01,
    ft: 0.3048,
    feet: 0.3048,
    foot: 0.3048,
    in: 0.0254,
    inches: 0.0254,
  };
  const unit = m.unit || pick(row, 'unit', 'units') || pick(root, 'unit', 'units');
  const s = units[key(String(unit ?? ''))];
  if (!s)
    throw new Error('Choose source units, or enter metres per source unit for a pixel drawing.');
  return s;
}
function number(v: any, label: string): number {
  const n = finite(v);
  if (n === undefined) throw new Error(`${label} must be a finite number.`);
  return n;
}
function geometry(v: any): MultiPolygon {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error('Boundary is not valid JSON.');
    }
  }
  if (v?.type === 'Feature') return geometry(v.geometry);
  if (v?.type === 'Polygon') v = [v.coordinates];
  else if (v?.type === 'MultiPolygon') v = v.coordinates;
  else if (v?.points) v = v.points;
  else if (v?.coordinates)
    throw new Error('Only planar Polygon and MultiPolygon geometry is supported.');
  if (!Array.isArray(v) || !v.length)
    throw new Error('No polygon boundary was found. Map the boundary field or hall dimensions.');
  const isPoint = (p: any) =>
    Array.isArray(p) && p.length === 2 && p.every((x) => finite(x) !== undefined);
  if (obj(v[0]) && 'x' in v[0]) v = v.map((p) => [number(p.x, 'x'), number(p.y, 'y')]);
  if (isPoint(v[0])) v = [[v]];
  else if (isPoint(v[0]?.[0])) v = [v];
  const result = v.map((poly: any) =>
    poly.map((r: any) => {
      const ring = r.map((p: any) => [number(p[0], 'x'), number(p[1], 'y')] as Point);
      if (ring.length && (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]))
        ring.push([...ring[0]]);
      return ring;
    }),
  );
  const problems = geometryProblems(result);
  if (problems.length) throw new Error(problems.join(' '));
  return result;
}
function shape(r: Obj): MultiPolygon {
  const polygon = pick(r, 'geometry', 'boundary', 'polygon', 'points');
  let g: MultiPolygon;
  if (polygon !== undefined) g = geometry(polygon);
  else if (!r.type || /^(rect|rectangle|area)$/i.test(r.type)) {
    const w = number(pick(r, 'width', 'w'), 'Area width'),
      h = number(pick(r, 'height', 'depth', 'h'), 'Area height');
    if (w <= 0 || h <= 0) throw new Error('An area has no positive size.');
    g = rectangle(0, 0, w, h);
  } else
    throw new Error(
      `Shape "${r.type}" needs a polygon export; it has not been dropped from the hall.`,
    );
  if (
    r.transformMatrix ||
    r.skewX ||
    r.skewY ||
    r.flipX ||
    r.flipY ||
    (r.originX && r.originX !== 'left') ||
    (r.originY && r.originY !== 'top')
  )
    throw new Error(
      'This shape has an unsupported canvas transform. Export its absolute polygon corners.',
    );
  const sx = r.scaleX === undefined ? 1 : number(r.scaleX, 'X scale'),
    sy = r.scaleY === undefined ? 1 : number(r.scaleY, 'Y scale');
  const angle = (number(r.angle ?? r.rotation ?? 0, 'Rotation') * Math.PI) / 180;
  const x = number(pick(r, 'x', 'left') ?? 0, 'x'),
    y = number(pick(r, 'y', 'top') ?? 0, 'y');
  return transform(g, (p) => [
    x + p[0] * sx * Math.cos(angle) - p[1] * sy * Math.sin(angle),
    y + p[0] * sx * Math.sin(angle) + p[1] * sy * Math.cos(angle),
  ]);
}
function legacyGeometry(f: HallFloor): FloorGeometry {
  const hall = difference(
    rectangle(0, 0, f.width, f.depth),
    ...f.areas
      .filter((a) => a.kind === 'outside')
      .map((a) => rectangle(a.x, a.y, a.width, a.height)),
  );
  const zones = (f.zones ?? []).map((z, i) => ({
    id: `zone-${i}`,
    name: z.name ?? `Foyer ${i + 1}`,
    kind: z.kind,
    geometry: union(...z.rects.map((r) => rectangle(r.x, r.y, r.width, r.height))),
    shared: false,
    hallKeys: [],
  }));
  return {
    schema: 'geometry/1',
    unit: 'm',
    boundary: union(hall, ...zones.map((z) => z.geometry)),
    hallBoundary: hall,
    grid: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    zones,
    objects: f.areas
      .filter((a) => a.kind !== 'outside')
      .map((a, i) => ({
        id: `area-${i}`,
        kind: a.kind,
        label: a.label ?? '',
        color: a.color ?? '#777777',
        geometry: rectangle(a.x, a.y, a.width, a.height),
        blocksStalls: blocksStalls(a.kind),
        evidence: { source: 'text', detail: 'Meaning from structured JSON' },
      })),
    source: { documentId: 'json', page: 1, regionId: 'hall', origin: [0, 0], metresPerUnit: 1 },
    review: { revision: 1, checks: [], acknowledgements: [] },
  };
}
function validateFloor(f: HallFloor): HallFloor {
  const issues = floorProblems(f);
  if (!Array.isArray(f.legend) || f.legend.length > 1000)
    issues.push('Legend must contain up to 1000 entries.');
  if (f.iconGroups.some((group) => !Array.isArray(group.icons) || group.icons.length > 100))
    issues.push('Each icon group must contain up to 100 icons.');
  if (f.geometry) {
    const g = f.geometry;
    if (![g.grid.x, g.grid.y, g.grid.width, g.grid.height, g.grid.rotation].every(Number.isFinite))
      issues.push('Invalid grid values.');
    if (g.schema !== 'geometry/1' || g.unit !== 'm')
      issues.push('Unsupported geometry schema or unit.');
    issues.push(...geometryProblems(g.hallBoundary));
    if (
      !Array.isArray(g.objects) ||
      g.objects.length > 1000 ||
      !Array.isArray(g.zones) ||
      g.zones.length > 100
    )
      throw new Error('Invalid geometry objects or zones.');
    for (const o of g.objects) {
      issues.push(...geometryProblems(o.geometry));
      o.label = cleanText(o.label) ?? '';
      o.color = cleanColor(o.color) ?? '#777777';
      if (!FLOOR_AREA_KINDS.includes(o.kind) || typeof o.blocksStalls !== 'boolean')
        issues.push('Invalid object meaning.');
    }
    for (const z of g.zones) {
      issues.push(...geometryProblems(z.geometry));
      z.name = cleanText(z.name) ?? 'Foyer';
      if (!['foyer', 'circulation'].includes(z.kind)) issues.push('Invalid zone meaning.');
    }
  }
  if (!f.labels.every((l) => typeof l.text === 'string' && [l.x, l.y].every(Number.isFinite)))
    issues.push('Invalid label.');
  if (issues.length) throw new Error(issues.slice(0, 5).join(' '));
  return f;
}
function canonical(v: Obj): HallFloor {
  for (const [k, max] of [
    ['areas', 1000],
    ['labels', 2000],
    ['iconGroups', 2000],
    ['zones', 100],
    ['legend', 1000],
  ] as const) {
    if (v[k] !== undefined && (!Array.isArray(v[k]) || v[k].length > max))
      throw new Error(`Too many or invalid ${k}.`);
  }
  // Never accept executable canvas state; store only the floor schema's data.
  const f: HallFloor = {
    schema: FLOOR_SCHEMA,
    width: number(v.width, 'Hall width'),
    depth: number(v.depth, 'Hall depth'),
    areas: (v.areas ?? []).map((a: Obj) => ({
      ...a,
      kind: kind(a.kind, {}),
      label: cleanText(a.label),
      color: cleanColor(a.color),
    })),
    labels: (v.labels ?? []).map((l: Obj) => ({
      text: cleanText(l.text) ?? '',
      x: number(l.x, 'Label x'),
      y: number(l.y, 'Label y'),
    })),
    iconGroups: (v.iconGroups ?? []).map((g: Obj) => {
      if (!Array.isArray(g.icons) || g.icons.length > 100)
        throw new Error('Each icon group must contain up to 100 icons.');
      return {
        x: number(g.x, 'Icon x'),
        y: number(g.y, 'Icon y'),
        icons: Array.isArray(g.icons)
          ? g.icons.map((i: Obj) => ({
              kind: cleanText(i.kind) ?? '',
              label: cleanText(i.label) ?? '',
            }))
          : [],
      };
    }),
    north: v.north
      ? {
          x: number(v.north.x, 'North x'),
          y: number(v.north.y, 'North y'),
          size: number(v.north.size, 'North size'),
          rotation: number(v.north.rotation, 'North rotation'),
          label: cleanText(v.north.label) ?? 'N',
        }
      : null,
    legend: Array.isArray(v.legend)
      ? v.legend.map((l: Obj) => ({
          label: cleanText(l.label) ?? '',
          color: cleanColor(l.color),
          showInView: l.showInView !== false,
          ...(cleanText(l.code, 40) ? { code: cleanText(l.code, 40) } : {}),
          ...(l.kind ? { kind: kind(l.kind, {}) } : {}),
        }))
      : [],
    zones: v.zones ?? [],
    ...(v.geometry ? { geometry: JSON.parse(JSON.stringify(v.geometry)) } : {}),
  };
  const problems = floorProblems(f);
  if (problems.length) throw new Error(problems.join(' '));
  if (!f.geometry) f.geometry = legacyGeometry(f);
  return validateFloor(f);
}
function convert(raw: Obj, root: Obj, m: JsonMapping, name: string): HallFloor {
  const row = obj(raw.floor) ?? raw;
  if (row.schema === FLOOR_SCHEMA) return canonical(row);
  if (row.legend !== undefined && !Array.isArray(row.legend))
    throw new Error('Legend must be an array.');
  const s = scaleFor({ ...root, ...raw, ...raw.properties, ...row }, root, m);
  const metric = (p: Point): Point => [p[0] * s, p[1] * s * (m.yAxis === 'up' ? -1 : 1)];
  if (
    row.type === 'Feature' &&
    /4326|longlat|wgs84/i.test(JSON.stringify(root.crs ?? row.crs ?? ''))
  )
    throw new Error(
      'Geographic coordinates need conversion to a planar local drawing before import.',
    );
  const read = (field: keyof JsonMapping, names: string[]) =>
    m[field] ? at(row, String(m[field])) : pick(row, ...names);
  const boundary =
    read('boundary', ['boundary', 'outline', 'polygon']) ??
    (row.type === 'Feature' ? row.geometry : undefined);
  const w = read('width', ['width', 'length', 'hallWidth']),
    d = read('depth', ['depth', 'breadth', 'height', 'hallDepth']);
  let hall =
    boundary !== undefined
      ? geometry(boundary)
      : rectangle(0, 0, number(w, 'Hall width'), number(d, 'Hall depth'));
  if (geometryProblems(hall).length || area(hall) <= 0)
    throw new Error('Hall dimensions or boundary are invalid.');
  hall = transform(hall, metric);
  const shapes = sourceAreas(row, m);
  const sourceZones = read('zones', ['zones', 'foyers']) ?? [];
  if (
    !Array.isArray(shapes) ||
    shapes.length > 1000 ||
    !Array.isArray(sourceZones) ||
    sourceZones.length > 100
  )
    throw new Error('Areas and foyers must be bounded arrays.');
  const labels: HallFloor['labels'] = [];
  const sourceLabels = pick(row, 'labels', 'annotations') ?? [];
  if (!Array.isArray(sourceLabels) || sourceLabels.length > 2000)
    throw new Error('Labels must be an array of up to 2000 entries.');
  for (const l of sourceLabels) {
    const p = metric([number(l.x ?? l.left ?? 0, 'Label x'), number(l.y ?? l.top ?? 0, 'Label y')]);
    labels.push({ text: cleanText(l.text ?? l.label) ?? '', x: p[0], y: p[1] });
  }
  const objects: FloorGeometry['objects'] = [];
  for (const [i, value] of shapes.entries()) {
    const original = obj(value);
    const a = original ? mappedArea(original, m) : null;
    if (!a) throw new Error(`Area ${i + 1} is not an object.`);
    if (/^(text|i-text|textbox)$/i.test(a.type ?? '')) {
      labels.push({
        text: cleanText(a.text) ?? '',
        x: number(a.left ?? a.x ?? 0, 'Text x') * s,
        y: number(a.top ?? a.y ?? 0, 'Text y') * s * (m.yAxis === 'up' ? -1 : 1),
      });
      continue;
    }
    const token =
      pick(a, 'kind', 'category', 'meaning', 'areaType') ??
      (a.type && !/^(rect|rectangle|polygon)$/i.test(a.type)
        ? a.type
        : pick(a, 'color', 'fillColor', 'fill'));
    const k = kind(token, m);
    objects.push({
      id: `area-${i}`,
      kind: k,
      label: cleanText(pick(a, 'label', 'name', 'title')) ?? '',
      geometry: transform(shape(a), metric),
      color: cleanColor(pick(a, 'color', 'fillColor', 'fill')) ?? '#777777',
      blocksStalls: typeof a.blocksStalls === 'boolean' ? a.blocksStalls : k !== 'marking',
      evidence: {
        source: m.kinds?.[String(token ?? '')] ? 'user' : 'text',
        detail: 'Meaning from JSON type or reviewed mapping',
      },
    });
  }
  const zones: FloorGeometry['zones'] = sourceZones.map((z: Obj, i: number) => ({
    id: `zone-${i}`,
    name: cleanText(z.name) ?? `Foyer ${i + 1}`,
    kind: /circulation|lobby/i.test(z.kind ?? z.role ?? '') ? 'circulation' : 'foyer',
    geometry: transform(shape(z), metric),
    shared: !!z.shared,
    hallKeys: [],
  }));
  hall = difference(hall, ...objects.filter((o) => o.kind === 'outside').map((o) => o.geometry));
  const boundaryAll = union(hall, ...zones.map((z) => z.geometry)),
    b = bounds(boundaryAll);
  const local = (g: MultiPolygon) => transform(g, (p) => [p[0] - b.x, p[1] - b.y]);
  const gridRaw = obj(row.grid) ?? {};
  const pitch = number(gridRaw.width ?? gridRaw.cellSize ?? row.gridSize ?? 1 / s, 'Grid width');
  const gridHeight = number(gridRaw.height ?? pitch, 'Grid height');
  const g: FloorGeometry = {
    schema: 'geometry/1',
    unit: 'm',
    boundary: local(boundaryAll),
    hallBoundary: local(hall),
    grid: {
      x: number(gridRaw.x ?? 0, 'Grid x') * s - b.x,
      y: number(gridRaw.y ?? 0, 'Grid y') * s * (m.yAxis === 'up' ? -1 : 1) - b.y,
      width: pitch * s,
      height: gridHeight * s,
      rotation: number(gridRaw.rotation ?? 0, 'Grid rotation') * (m.yAxis === 'up' ? -1 : 1),
    },
    objects: objects
      .filter((o) => o.kind !== 'outside')
      .map((o) => ({ ...o, geometry: local(o.geometry) })),
    zones: zones.map((z) => ({ ...z, geometry: local(z.geometry) })),
    source: {
      documentId: 'json',
      page: 1,
      regionId: name,
      origin: [b.x / s, b.y / s],
      metresPerUnit: s,
    },
    review: { revision: 1, checks: [], acknowledgements: [] },
  };
  return validateFloor({
    schema: FLOOR_SCHEMA,
    width: b.width,
    depth: b.height,
    geometry: g,
    areas: [],
    labels: labels.map((l) => ({ ...l, x: l.x - b.x, y: l.y - b.y })),
    iconGroups: (row.iconGroups ?? []).map((g: Obj) => {
      const p = metric([number(g.x, 'Icon x'), number(g.y, 'Icon y')]);
      return {
        x: p[0] - b.x,
        y: p[1] - b.y,
        icons: (g.icons ?? []).map((i: Obj) => ({
          kind: cleanText(i.kind) ?? '',
          label: cleanText(i.label) ?? '',
        })),
      };
    }),
    north: row.north
      ? {
          x: number(row.north.x, 'North x') * s - b.x,
          y: number(row.north.y, 'North y') * s * (m.yAxis === 'up' ? -1 : 1) - b.y,
          size: number(row.north.size, 'North size') * s,
          rotation: number(row.north.rotation ?? 0, 'North rotation'),
          label: cleanText(row.north.label) ?? 'N',
        }
      : null,
    legend: Array.isArray(row.legend)
      ? row.legend.map((l: Obj) => ({
          label: cleanText(l.label) ?? '',
          color: cleanColor(l.color),
          showInView: l.showInView !== false,
          ...(l.kind ? { kind: kind(l.kind, m) } : {}),
        }))
      : [],
  });
}
export function adaptJson(content: string, mapping: JsonMapping = {}): JsonAdaptation {
  mapping = mappingSchema.parse(mapping);
  let root: any;
  try {
    root = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const records = mapping.halls ? at(root, mapping.halls) : unwrap(root);
  const rows = Array.isArray(records) ? records : [records];
  if (!rows.length || rows.length > 500 || rows.some((r) => !obj(r)))
    throw new Error('Choose a hall object or an array of up to 500 halls.');
  const seen = new Set<string>();
  const result = rows.map((raw: Obj, i: number): JsonRow => {
    const name =
      cleanText(
        mapping.name
          ? at(raw, mapping.name)
          : (pick(raw, 'name', 'hallName', 'title') ?? raw.properties?.name),
        120,
      ) ?? `Hall ${i + 1}`;
    const isItpo =
      pick(raw, 'layoutData') !== undefined &&
      pick(raw, 'hallId') !== undefined &&
      raw.length !== undefined &&
      raw.breadth !== undefined;
    const identity = cleanText(pick(raw, 'id', 'hallId', 'externalId'), 200);
    const externalId = createHash('sha256')
      .update(
        identity
          ? `id:${identity}`
          : mapping.name || pick(raw, 'name', 'hallName', 'title') || raw.properties?.name
            ? `name:${name}`
            : `file:${content}:row:${i}`,
      )
      .digest('hex')
      .slice(0, 32);
    const r: JsonRow = {
      externalId,
      name,
      floor: null,
      warnings: [],
      error: null,
      source: isItpo ? 'itpo' : 'json',
    };
    try {
      const seenId = isItpo ? `itpo:${pick(raw, 'hallId')}` : externalId;
      if (seen.has(seenId)) throw new Error('Duplicate hall identity in this file.');
      seen.add(seenId);
      if (isItpo) {
        const legacy = readItpoHallRows(JSON.stringify(raw), 'json')[0],
          adapted = itpoRowToFloor(legacy);
        r.externalId = legacy.hallId;
        r.name = legacy.name ?? name;
        r.floor = canonical({
          ...adapted.floor,
          ...(raw.geometry ? { geometry: raw.geometry } : {}),
        });
        r.warnings = adapted.warnings;
      } else r.floor = convert(raw, obj(root) ?? {}, mapping, name);
      if (!identity && !isItpo)
        r.warnings.push(
          'No source hall ID: named halls are matched by source name; unnamed halls are matched only for the identical uploaded file.',
        );
      if (!obj(raw.floor)?.schema && raw.schema !== FLOOR_SCHEMA && !isItpo && !obj(raw.grid))
        r.warnings.push('No source grid was supplied; preview uses a 1 metre design grid.');
    } catch (e) {
      r.error = e instanceof Error ? e.message : 'Could not adapt this hall.';
    }
    return r;
  });
  const areaTypes = [
    ...new Set(
      rows.flatMap((r) => {
        const a = sourceAreas(obj(r.floor) ?? r, mapping);
        return Array.isArray(a)
          ? a
              .filter((o) => obj(o) && !/^(text|i-text|textbox)$/i.test(o.type ?? ''))
              .map((original) => {
                const o = mappedArea(original, mapping);
                return String(
                  pick(o, 'kind', 'category', 'meaning', 'areaType') ??
                    (o.type && !/^(rect|rectangle|polygon)$/i.test(o.type)
                      ? o.type
                      : pick(o, 'color', 'fillColor', 'fill')) ??
                    '',
                );
              })
          : [];
      }),
    ),
  ] as string[];
  return {
    rows: result,
    fields: fields(rows[0]).slice(0, 200),
    collectionPaths: collections(root).slice(0, 100),
    areaTypes,
  };
}

const fieldPath = z
  .string()
  .max(200)
  .refine(
    (p) => !p.split('.').some((s) => ['__proto__', 'prototype', 'constructor'].includes(s)),
    'Invalid field path',
  );
const mappingSchema = z
  .object({
    halls: fieldPath.optional(),
    name: fieldPath.optional(),
    width: fieldPath.optional(),
    depth: fieldPath.optional(),
    boundary: fieldPath.optional(),
    areas: fieldPath.optional(),
    zones: fieldPath.optional(),
    unit: z.string().max(30).optional(),
    metresPerUnit: z.number().finite().positive().max(1000).optional(),
    yAxis: z.enum(['up', 'down']).optional(),
    kinds: z
      .record(z.string().max(200), z.enum(FLOOR_AREA_KINDS as [AreaKind, ...AreaKind[]]))
      .refine((v) => Object.keys(v).length <= 1000, 'Too many kind mappings')
      .optional(),
    areaFields: z
      .object({
        x: fieldPath.optional(),
        y: fieldPath.optional(),
        width: fieldPath.optional(),
        height: fieldPath.optional(),
        kind: fieldPath.optional(),
        label: fieldPath.optional(),
        geometry: fieldPath.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
function mappedArea(a: Obj, m: JsonMapping): Obj {
  const result = { ...a };
  for (const [k, path] of Object.entries(m.areaFields ?? {})) if (path) result[k] = at(a, path);
  return result;
}
function sourceAreas(row: Obj, m: JsonMapping): any {
  if (m.areas) return at(row, m.areas) ?? [];
  const primary =
    pick(row, 'areas', 'obstacles', 'restrictions', 'objects', 'nonClickableAreas') ?? [];
  if (!Array.isArray(primary)) return primary;
  const groups: Record<string, AreaKind> = {
    walls: 'wall',
    columns: 'column',
    pillars: 'column',
    passages: 'passage',
    corridors: 'passage',
    facilities: 'facility',
    utilities: 'utility',
    exits: 'entry',
  };
  return [
    ...primary,
    ...Object.entries(groups).flatMap(([field, kind]) => {
      const values = pick(row, field);
      return Array.isArray(values) && values !== primary
        ? values.map((a) => ({ ...a, kind: a.kind ?? kind }))
        : [];
    }),
  ];
}
