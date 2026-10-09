import { z } from 'zod';
import { parseCsv } from '../../integrations/csv';
import { cleanText, finite, FLOOR_AREA_KINDS } from '../floor/hall-floor';
import { area, intersection, rectangle, union } from '../floor-plan/geometry';
import type { AreaKind, MultiPolygon } from '../floor-plan/plan.types';
import {
  adaptJson,
  AREA_GROUPS,
  at,
  FIELD_NAMES,
  geometry,
  JsonAdaptation,
  JsonMapping,
  JsonRow,
  key,
  mappingSchema,
} from './adapter';

/** What one CSV row is: a whole hall, or one space of a hall (its outline, a foyer, a pillar). */
export type CsvRowLayout = 'hall' | 'space';
/** Meanings a space row can have besides an area kind. Stall rows are reported, never imported. */
export type SpaceRole = 'hall' | 'foyer' | 'circulation' | 'stall';
/** A JSON mapping plus the row layout; `kinds` may also give a space row's {@link SpaceRole}. */
export interface CsvMapping extends JsonMapping {
  rows?: CsvRowLayout;
}
/** A field a column can be mapped to. `width`/`depth` are the hall's, or each space's by row. */
export type CsvField =
  | 'id'
  | 'name'
  | 'width'
  | 'depth'
  | 'boundary'
  | 'zones'
  | 'areas'
  | 'unitField'
  | 'kind'
  | 'x'
  | 'y'
  | 'label'
  | 'geometry';
export interface CsvAdaptation extends JsonAdaptation {
  rowLayout: CsvRowLayout;
  /** `itpo`: a recognised layout export, read by its own column names. */
  format: 'itpo' | 'generic';
  columns: string[];
  /** The first value of each column, shortened, so a column is recognisable by its content. */
  samples: Record<string, string>;
  /** The column each field reads when the field is not mapped. */
  suggested: Partial<Record<CsvField, string>>;
  /** Columns read without a field mapping, and what they are read as. */
  autoColumns: Record<string, string>;
  /** Required fields without a column. `unit`: neither the file nor the mapping states units. */
  missing: (CsvField | 'unit')[];
  /** `space`: rows share hall IDs and have space columns, so they look like one row per space. */
  layoutHint?: CsvRowLayout;
}

type Obj = Record<string, any>;
/** Field → names recognised exactly as the JSON adapter does, then other common names. */
type FieldNames = [CsvField, readonly string[], readonly string[]][];
const HALL_FIELDS: FieldNames = [
  ['id', FIELD_NAMES.id, ['hallNo', 'hallNumber', 'hallCode', 'hallRef', 'code', 'reference']],
  ['name', FIELD_NAMES.name, ['hall', 'hallTitle']],
  ['width', FIELD_NAMES.width, ['hallLength', 'lengthX', 'sizeX']],
  ['depth', FIELD_NAMES.depth, ['hallBreadth', 'sizeY']],
  ['boundary', FIELD_NAMES.boundary, ['hallOutline', 'hallBoundary', 'hallPolygon', 'perimeter']],
  ['zones', FIELD_NAMES.zones, ['foyer', 'foyerAreas', 'foyerZones', 'lobbies']],
  ['areas', FIELD_NAMES.areas, ['obstructions', 'restrictedAreas', 'blockedAreas']],
  ['unitField', FIELD_NAMES.unitField, ['unitOfMeasure', 'uom', 'measurementUnit']],
];
const SPACE_FIELDS: FieldNames = [
  ['id', [], ['hall', 'hallId', 'hallNo', 'hallNumber', 'hallCode', 'hallRef', 'hallName']],
  ['name', [], ['hallName', 'hallTitle']],
  ['kind', [], ['type', 'spaceType', 'kind', 'category', 'elementType', 'areaType', 'usage']],
  ['x', [], ['x', 'left', 'posX', 'xPosition', 'originX', 'startX']],
  ['y', [], ['y', 'top', 'posY', 'yPosition', 'originY', 'startY']],
  ['width', [], ['width', 'length', 'w', 'sizeX']],
  ['depth', [], ['depth', 'breadth', 'height', 'h', 'sizeY']],
  ['geometry', [], ['polygon', 'geometry', 'points', 'coordinates', 'outline']],
  ['label', [], ['label', 'name', 'spaceName', 'title', 'description']],
  ['unitField', [], ['unit', 'units', 'unitOfMeasure', 'uom', 'measurementUnit']],
];
/** Space types recognised without a mapping, compared ignoring case, spaces and punctuation. */
const SPACE_ROLES: Record<string, SpaceRole> = {
  hall: 'hall',
  halloutline: 'hall',
  hallboundary: 'hall',
  outline: 'hall',
  boundary: 'hall',
  perimeter: 'hall',
  foyer: 'foyer',
  prefunction: 'foyer',
  lobby: 'circulation',
  circulation: 'circulation',
  stall: 'stall',
  booth: 'stall',
  stand: 'stall',
  plot: 'stall',
};
const UNITS: Record<string, string> = {
  m: 'm',
  metre: 'm',
  metres: 'm',
  meter: 'm',
  meters: 'm',
  mm: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  cm: 'cm',
  ft: 'ft',
  feet: 'ft',
  foot: 'ft',
  in: 'in',
  inch: 'in',
  inches: 'in',
};
/** A unit at the end of a header: "Length (m)", "X [mm]", "width_ft", "Breadth in metres". */
const HEADER_UNIT = /(?:\(\s*([a-z]+)\s*\)|\[\s*([a-z]+)\s*\]|[\s_-]+(?:in\s+)?([a-z]+))\s*$/i;
const unitOf = (header: string) => {
  const m = header.match(HEADER_UNIT);
  return m ? UNITS[(m[1] ?? m[2] ?? m[3]).toLowerCase()] : undefined;
};
/** A header compared without its unit, so "Length (m)" is recognised as "length". */
const loose = (header: string) => key(unitOf(header) ? header.replace(HEADER_UNIT, '') : header);

const csvMappingSchema = mappingSchema.extend({
  rows: z.enum(['hall', 'space']).optional(),
  kinds: z
    .record(
      z.string().max(200),
      z.enum(['hall', 'foyer', 'circulation', 'stall', ...FLOOR_AREA_KINDS] as [
        string,
        ...string[],
      ]),
    )
    .refine((v) => Object.keys(v).length <= 1000, 'Too many kind mappings')
    .optional(),
});

/**
 * One CSV record is one hall, with structured geometry/annotation cells as JSON; or, with
 * `rows: 'space'`, one space of a hall, grouped into halls by the hall column.
 */
export function adaptCsv(content: string, input: CsvMapping = {}): CsvAdaptation {
  const { rows: layout = 'hall', ...mapping } = csvMappingSchema.parse(input) as CsvMapping;
  const [header, ...lines] = parseCsv(content);
  if (!header) throw new Error('The CSV is empty. Include a header row and at least one hall.');
  const keys = header.map((h) => h.trim());
  if (keys.some((h) => !h) || new Set(keys).size !== keys.length)
    throw new Error('CSV column names must be non-empty and unique.');
  const rows = lines.filter((row) => row.some((cell) => cell.trim()));
  const limit = layout === 'space' ? 10_000 : 500;
  if (!rows.length || rows.length > limit)
    throw new Error(`The CSV must contain between 1 and ${limit} ${layout} rows.`);
  const errors = new Map<number, string>();
  const records = rows.map((row, index) => {
    if (row.length !== keys.length)
      throw new Error(
        `CSV row ${index + 2} has ${row.length} columns; expected ${keys.length}. Quote cells containing commas or line breaks.`,
      );
    return Object.fromEntries(
      keys.map((key, i) => {
        const value = row[i].trim();
        if (!value || value === 'NULL' || value === 'null') return [key, null];
        if (/^[\[{]/.test(value)) {
          try {
            return [key, JSON.parse(value)];
          } catch {
            errors.set(index, `CSV row ${index + 2}: column "${key}" contains invalid JSON.`);
          }
        }
        return [key, value];
      }),
    ) as Obj;
  });
  const samples = Object.fromEntries(
    keys.map((k, i) => {
      const value = rows.map((row) => row[i].trim()).find((v) => v && !/^null$/i.test(v)) ?? '';
      return [k, value.length > 60 ? `${value.slice(0, 57)}…` : value];
    }),
  );
  const areaKinds = Object.fromEntries(
    Object.entries(mapping.kinds ?? {}).filter(([, v]) => FLOOR_AREA_KINDS.includes(v as AreaKind)),
  ) as Record<string, AreaKind>;
  const base = { columns: keys, samples, collectionPaths: [] as string[] };
  if (layout === 'space')
    return spaces(
      records,
      keys,
      { ...mapping, kinds: areaKinds },
      mapping.kinds ?? {},
      errors,
      base,
    );

  const itpo =
    keys.includes('length') &&
    keys.includes('breadth') &&
    keys.some((k) => key(k) === 'hallid') &&
    keys.some((k) => key(k) === 'layoutdata');
  const suggested: CsvAdaptation['suggested'] = {};
  const autoColumns: Record<string, string> = {};
  const json: JsonMapping = { ...mapping, kinds: areaKinds };
  const notes: string[] = [];
  const missing: CsvAdaptation['missing'] = [];
  let layoutHint: CsvRowLayout | undefined;
  if (itpo) {
    // Read by the ITPO reader under its own column names; a mapping does not apply to it.
    const named = (name: string) => keys.find((k) => key(k) === name);
    for (const [field, name] of [
      ['id', 'hallid'],
      ['name', 'name'],
      ['width', 'length'],
      ['depth', 'breadth'],
      ['areas', 'layoutdata'],
    ] as const)
      if (named(name)) suggested[field] = named(name);
    for (const [name, label] of [
      ['legends', 'Legend'],
      ['helpertext', 'Helper icons'],
      ['exitlabels', 'Exit labels'],
      ['direction', 'North arrow'],
      ['defaultstalls', 'Template stalls (reported, not imported)'],
    ])
      if (named(name)) autoColumns[named(name)!] = label;
  } else {
    const found = suggest(keys, HALL_FIELDS);
    Object.assign(suggested, found.columns);
    // Exact names are found by the JSON adapter itself; other names are passed as a mapping.
    for (const field of found.loose) {
      const target = field as keyof JsonMapping;
      if (json[target] === undefined) (json as Obj)[target] = found.columns[field];
    }
    const column = (field: CsvField) => {
      const mapped = mapping[field as keyof JsonMapping];
      return mapped !== undefined ? (mapped as string) || undefined : suggested[field];
    };
    if (mapping.areas === undefined)
      for (const k of keys) {
        const group = Object.keys(AREA_GROUPS).find((g) => key(g) === key(k));
        if (group && k !== column('areas')) autoColumns[k] = `Areas (${AREA_GROUPS[group]})`;
      }
    if (!column('boundary'))
      missing.push(...(['width', 'depth'] as const).filter((f) => !column(f)));
    if (!mapping.unit && !column('unitField')) {
      const unit = unitFrom([column('width'), column('depth')]);
      if (unit) {
        json.unit = unit.unit;
        notes.push(`Units read from the column headers: ${unit.unit} (${unit.columns}).`);
      } else missing.push('unit');
    }
    const idColumn = column('id');
    const ids = idColumn ? records.map((r) => cleanText(at(r, idColumn), 200)).filter(Boolean) : [];
    const space = suggest(keys, SPACE_FIELDS).columns;
    if (new Set(ids).size < ids.length && space.kind && (space.geometry || (space.x && space.y)))
      layoutHint = 'space';
  }
  for (const record of records)
    if (!record.name && record.hall_id) record.name = `Hall ${record.hall_id}`;
  const adapted = adaptJson(JSON.stringify(records), json);
  for (const [index, row] of adapted.rows.entries()) {
    row.source = 'csv';
    row.warnings.push(...notes);
    if (errors.has(index)) {
      row.error = errors.get(index)!;
      row.floor = null;
    }
    checkFloor(row, false);
  }
  return {
    ...adapted,
    ...base,
    rowLayout: 'hall',
    format: itpo ? 'itpo' : 'generic',
    suggested,
    autoColumns,
    missing,
    ...(layoutHint ? { layoutHint } : {}),
  };
}

/** Rows that are spaces of halls: grouped by the hall column into one hall object each. */
function spaces(
  records: Obj[],
  keys: string[],
  mapping: JsonMapping,
  roles: Record<string, string>,
  errors: Map<number, string>,
  base: Pick<CsvAdaptation, 'columns' | 'samples' | 'collectionPaths'>,
): CsvAdaptation {
  const found = suggest(keys, SPACE_FIELDS);
  const area = mapping.areaFields ?? {};
  const column = (field: CsvField, mapped: string | undefined) =>
    mapped !== undefined ? mapped || undefined : found.columns[field];
  const col = {
    id: column('id', mapping.id),
    name: column('name', mapping.name),
    unitField: column('unitField', mapping.unitField),
    kind: column('kind', area.kind),
    x: column('x', area.x),
    y: column('y', area.y),
    width: column('width', area.width),
    depth: column('depth', area.height),
    geometry: column('geometry', area.geometry),
    label: column('label', area.label),
  };
  const unit =
    !mapping.unit && !col.unitField ? unitFrom([col.x, col.y, col.width, col.depth]) : null;
  const missing: CsvAdaptation['missing'] = [
    ...(['id', 'kind'] as const).filter((f) => !col[f]),
    ...(col.geometry ? [] : (['x', 'y', 'width', 'depth'] as const).filter((f) => !col[f])),
  ];
  const result = {
    ...base,
    fields: keys,
    areaTypes: col.kind
      ? [...new Set(records.map((r) => cleanText(at(r, col.kind!), 200) ?? ''))]
      : [],
    rowLayout: 'space' as const,
    format: 'generic' as const,
    suggested: found.columns,
    autoColumns: {},
    missing: [...missing, ...(!mapping.unit && !col.unitField && !unit ? ['unit' as const] : [])],
  };
  if (missing.length) return { ...result, rows: [] };
  const groups = new Map<string, number[]>();
  records.forEach((r, i) => {
    const hall = cleanText(at(r, col.id!), 200);
    if (!hall) throw new Error(`CSV row ${i + 2} has no hall in column "${col.id}".`);
    groups.set(hall, [...(groups.get(hall) ?? []), i]);
  });
  if (groups.size > 500) throw new Error('The CSV must describe at most 500 halls.');
  const halls = [...groups].map(([id, indexes]) => hallOf(id, indexes, records, col, roles));
  // The hall objects use the adapter's own field names: only units and meanings still apply.
  const json: JsonMapping = { kinds: mapping.kinds };
  if (mapping.unit || unit) json.unit = mapping.unit || unit!.unit;
  if (mapping.metresPerUnit !== undefined) json.metresPerUnit = mapping.metresPerUnit;
  if (mapping.yAxis) json.yAxis = mapping.yAxis;
  const adapted = adaptJson(JSON.stringify(halls.map((h) => h.hall)), json);
  for (const [index, row] of adapted.rows.entries()) {
    const { indexes, warnings, error } = halls[index];
    const cellError = indexes.map((i) => errors.get(i)).find(Boolean);
    row.source = 'csv';
    row.records = indexes.length;
    row.warnings.push(...warnings);
    if (unit)
      row.warnings.push(`Units read from the column headers: ${unit.unit} (${unit.columns}).`);
    if (error || cellError) {
      row.error = cellError ?? error;
      row.floor = null;
    }
    checkFloor(row, true);
  }
  return { ...adapted, ...result };
}

/** One hall from its rows. Its outline comes only from its outline rows, never from its spaces. */
function hallOf(
  id: string,
  indexes: number[],
  records: Obj[],
  col: Record<
    'name' | 'unitField' | 'kind' | 'x' | 'y' | 'width' | 'depth' | 'geometry' | 'label',
    string | undefined
  >,
  roles: Record<string, string>,
) {
  const warnings: string[] = [];
  const outline: MultiPolygon[] = [],
    foyers: Obj[] = [],
    areas: Obj[] = [];
  const seen = new Set<string>(),
    units = new Set<string>();
  let name: string | undefined,
    stalls = 0,
    duplicates = 0;
  const fallback = /^hall\b/i.test(id) ? id : `Hall ${id}`;
  try {
    for (const i of indexes) {
      const r = records[i];
      name ??= col.name ? cleanText(at(r, col.name), 120) : undefined;
      const unit = col.unitField ? cleanText(at(r, col.unitField), 30) : undefined;
      if (unit) units.add(UNITS[key(unit)] ?? unit.toLowerCase());
      const token = cleanText(at(r, col.kind!), 200) ?? '';
      const role =
        roles[token] ??
        SPACE_ROLES[key(token)] ??
        (/foyer/i.test(token) ? 'foyer' : /stall|booth/i.test(token) ? 'stall' : token);
      if (role === 'stall') {
        stalls++;
        continue;
      }
      const label = col.label ? cleanText(at(r, col.label), 200) : undefined;
      const shape = shapeOf(r, i, col);
      const signature = JSON.stringify([role, label ?? '', shape]);
      if (seen.has(signature)) {
        duplicates++;
        continue;
      }
      seen.add(signature);
      if (role === 'hall') outline.push(shape);
      else if (role === 'foyer' || role === 'circulation')
        foyers.push({ name: label, kind: role, geometry: shape });
      else areas.push({ kind: token, label, geometry: shape });
    }
    if (units.size > 1)
      throw new Error(`The rows of this hall use different units: ${[...units].join(', ')}.`);
    if (!outline.length)
      throw new Error(
        'No hall outline row. Add a row of type Hall with the hall’s position and size, or choose Hall outline for its type in Area meanings. The outline is never guessed from the spaces.',
      );
    if (stalls)
      warnings.push(`${stalls} stall row(s) were not imported: stalls come with the planner.`);
    if (duplicates) warnings.push(`${duplicates} duplicate row(s) were skipped.`);
    return {
      indexes,
      warnings,
      error: null,
      hall: {
        id,
        name: name ?? fallback,
        ...(units.size ? { unit: [...units][0] } : {}),
        boundary: union(...outline),
        foyers,
        areas,
      },
    };
  } catch (e) {
    return {
      indexes,
      warnings,
      error: e instanceof Error ? e.message : 'Could not read the rows of this hall.',
      hall: { id, name: name ?? fallback },
    };
  }
}

/** A space's polygon, or its rectangle from position and size, in the file's units. */
function shapeOf(r: Obj, i: number, col: Record<string, string | undefined>): MultiPolygon {
  const polygon = col.geometry ? at(r, col.geometry) : null;
  try {
    if (polygon !== null && polygon !== undefined) return geometry(polygon);
  } catch (e) {
    throw new Error(`CSV row ${i + 2}: ${e instanceof Error ? e.message : 'invalid polygon.'}`);
  }
  const value = (column: string | undefined, label: string) => {
    const n = column ? finite(at(r, column)) : undefined;
    if (n === undefined) throw new Error(`CSV row ${i + 2}: ${label} must be a number.`);
    return n;
  };
  const x = value(col.x, 'X'),
    y = value(col.y, 'Y'),
    width = value(col.width, 'Width'),
    depth = value(col.depth, 'Depth');
  if (width <= 0 || depth <= 0)
    throw new Error(`CSV row ${i + 2}: width and depth must be greater than 0.`);
  return rectangle(x, y, width, depth);
}

/** The column each field reads: names known to the JSON adapter first, then common names. */
function suggest(keys: string[], fields: FieldNames) {
  const columns: Partial<Record<CsvField, string>> = {};
  const taken = new Set<string>(),
    looseFields: CsvField[] = [];
  for (const [field, exact] of fields) {
    // Mirrors the JSON adapter: the first column, in file order, with any of the exact names.
    const column = keys.find((k) => exact.some((name) => key(k) === key(name)));
    if (column) {
      columns[field] = column;
      taken.add(column);
    }
  }
  for (const [field, exact, other] of fields) {
    if (columns[field]) continue;
    for (const name of [...exact, ...other]) {
      const column = keys.find((k) => !taken.has(k) && loose(k) === key(name));
      if (column) {
        columns[field] = column;
        taken.add(column);
        looseFields.push(field);
        break;
      }
    }
  }
  return { columns, loose: looseFields };
}

/** The unit the given headers state, when they state exactly one. */
function unitFrom(columns: (string | undefined)[]) {
  const stated = columns.filter((c): c is string => !!c && !!unitOf(c));
  const units = new Set(stated.map((c) => unitOf(c)));
  return units.size === 1 ? { unit: [...units][0]!, columns: stated.join(', ') } : null;
}

/** Marks a converted floor as from CSV and warns what the visual review must check. */
function checkFloor(row: JsonRow, spaceRows: boolean) {
  const g = row.floor?.geometry;
  if (!g) return;
  if (g.source.documentId === 'json') {
    g.source.documentId = 'csv';
    for (const o of g.objects)
      if (o.evidence?.detail === 'Meaning from structured JSON')
        o.evidence.detail = 'Meaning from structured CSV';
  }
  for (const z of g.zones) {
    const overlap = area(intersection(z.geometry, g.hallBoundary));
    if (overlap > 0.01)
      row.warnings.push(
        `${z.name} overlaps the hall floor by ${Math.round(overlap * 100) / 100} m². A foyer lies beside the hall: check its position.`,
      );
  }
  if (!spaceRows) return;
  // A space assigned to the wrong hall lands outside that hall's floor.
  const outside = g.objects.filter((o) => area(intersection(o.geometry, g.boundary)) < 1e-6);
  if (outside.length)
    row.warnings.push(
      `${outside.length} space(s) lie outside the hall and its foyers (${outside
        .slice(0, 5)
        .map((o) => o.label || o.kind)
        .join(', ')}). Check their hall column.`,
    );
}
