/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. Database
 * exports put whole JSON documents in one field, so a line-based split is never enough.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A byte-order mark is not part of the first header.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (quoted) {
    throw new Error('The CSV ends inside a quoted field.');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV rows as objects keyed by the header row. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) {
    return [];
  }
  const keys = header.map((key) => key.trim());
  return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i] ?? ''])));
}
