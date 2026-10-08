import { parseCsv } from '../../integrations/csv';
import { adaptJson, JsonAdaptation, JsonMapping } from './adapter';

/** One CSV record is one hall; structured geometry/annotation cells contain JSON. */
export function adaptCsv(content: string, mapping: JsonMapping = {}): JsonAdaptation {
  const [header, ...lines] = parseCsv(content);
  if (!header) throw new Error('The CSV is empty. Include a header row and at least one hall.');
  const keys = header.map((h) => h.trim());
  if (keys.some((h) => !h) || new Set(keys).size !== keys.length)
    throw new Error('CSV column names must be non-empty and unique.');
  const rows = lines.filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length || rows.length > 500)
    throw new Error('The CSV must contain between 1 and 500 hall rows.');
  const errors = new Map<number, string>();
  const records = rows.map((row, index) => {
    if (row.length !== keys.length)
      throw new Error(
        `CSV row ${index + 2} has ${row.length} columns; expected ${keys.length}. Quote cells containing commas or line breaks.`,
      );
    const record = Object.fromEntries(
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
    );
    if (!record.name && record.hall_id) record.name = `Hall ${record.hall_id}`;
    return record;
  });
  const adapted = adaptJson(JSON.stringify(records), mapping);
  for (const [index, row] of adapted.rows.entries()) {
    row.source = 'csv';
    if (errors.has(index)) {
      row.error = errors.get(index)!;
      row.floor = null;
    }
    if (row.floor?.geometry?.source?.documentId === 'json') {
      row.floor.geometry.source.documentId = 'csv';
      for (const o of row.floor.geometry.objects)
        if (o.evidence?.detail === 'Meaning from structured JSON')
          o.evidence.detail = 'Meaning from structured CSV';
    }
  }
  return adapted;
}
