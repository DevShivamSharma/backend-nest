import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { itpoRowToFloor, readItpoHallRows } from '../../src/integrations/itpo/itpo-hall-layout';
import type { HallFloor } from '../../src/venues/floor/hall-floor';

export function floorSvg(f: HallFloor, s = 8): string {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${f.width * s}" height="${f.depth * s}"><rect width="100%" height="100%" fill="#e8f4e8"/>`];
  for (const a of f.areas) {
    const fill = a.kind === 'outside' ? '#ffffff' : a.kind === 'wall' ? '#742371' : (a.color ?? '#888');
    parts.push(`<rect x="${a.x * s}" y="${a.y * s}" width="${a.width * s}" height="${a.height * s}" fill="${fill}" fill-opacity="${a.hidden ? 0.3 : 0.85}" stroke="#000" stroke-width="0.3"/>`);
  }
  for (const l of f.labels) parts.push(`<text x="${l.x * s}" y="${l.y * s}" font-size="9" fill="#00f">${l.text.replace(/[<&]/g, '')}</text>`);
  for (const g of f.iconGroups) parts.push(`<circle cx="${g.x * s}" cy="${g.y * s}" r="3" fill="#f0f"/><text x="${g.x * s + 4}" y="${g.y * s}" font-size="7">${g.icons.map((i) => i.kind).join(',')}</text>`);
  parts.push('</svg>');
  return parts.join('');
}
if (require.main === module) {
  const rows = readItpoHallRows(readFileSync('/home/cms/T_HALL_LAYOUTS.csv', 'utf8'), 'csv');
  const hall = process.argv[2];
  const row = rows.find((r) => r.hallId === hall)!;
  const { floor, warnings } = itpoRowToFloor(row);
  console.log(floor.width, floor.depth, floor.areas.length, warnings);
  sharp(Buffer.from(floorSvg(floor))).png().toFile(process.argv[3]).then(() => console.log('ok'));
}
