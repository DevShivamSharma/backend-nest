export interface LayoutIntent {
  action: 'place' | 'clear' | 'none';
  stallSize: { width: number; length: number };
  count: number | null;
  area: { type: 'whole_hall' | 'region' | 'near_marker' | 'along_wall' | 'rect'; marker?: string; wall?: 'north' | 'south' | 'east' | 'west'; rect?: { minX: number; minZ: number; maxX: number; maxZ: number } };
  arrangement: 'rows' | 'back_to_back' | 'island' | 'perimeter';
  aisleWidth: number | null;
  openSide: 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT' | null;
  namePrefix: string | null;
  clarification: string | null;
}

const choice = (values: string[]) => ({ type: 'STRING', enum: values });
export const INTENT_SCHEMA = {
  type: 'OBJECT', required: ['action', 'stallSize', 'count', 'area', 'arrangement', 'aisleWidth', 'openSide', 'namePrefix', 'clarification'],
  properties: {
    action: choice(['place', 'clear', 'none']),
    stallSize: { type: 'OBJECT', required: ['width', 'length'], properties: { width: { type: 'NUMBER' }, length: { type: 'NUMBER' } } },
    count: { type: 'INTEGER', nullable: true },
    area: { type: 'OBJECT', required: ['type'], properties: {
      type: choice(['whole_hall', 'region', 'near_marker', 'along_wall', 'rect']),
      marker: { type: 'STRING' }, wall: choice(['north', 'south', 'east', 'west']),
      rect: { type: 'OBJECT', required: ['minX', 'minZ', 'maxX', 'maxZ'], properties: Object.fromEntries(['minX', 'minZ', 'maxX', 'maxZ'].map(k => [k, { type: 'NUMBER' }])) }
    } },
    arrangement: choice(['rows', 'back_to_back', 'island', 'perimeter']),
    aisleWidth: { type: 'NUMBER', nullable: true },
    openSide: { ...choice(['FRONT', 'BACK', 'LEFT', 'RIGHT']), nullable: true },
    namePrefix: { type: 'STRING', nullable: true }, clarification: { type: 'STRING', nullable: true }
  }
};

function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an intent object.');
  const v = value as Record<string, any>;
  if (required.some(k => !(k in v)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) throw new Error('Unexpected or missing intent field.');
  return v;
}
const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function validateIntent(raw: unknown): LayoutIntent {
  const v = object(raw, INTENT_SCHEMA.required);
  const size = object(v.stallSize, ['width', 'length']);
  const a = object(v.area, ['type'], ['marker', 'wall', 'rect']);
  if (!['place', 'clear', 'none'].includes(v.action) || !number(size.width, .5, 100) || !number(size.length, .5, 100) ||
      !(v.count === null || (number(v.count, 1, 500) && Number.isInteger(v.count))) ||
      !['whole_hall', 'region', 'near_marker', 'along_wall', 'rect'].includes(a.type) ||
      !['rows', 'back_to_back', 'island', 'perimeter'].includes(v.arrangement) ||
      !(v.aisleWidth === null || number(v.aisleWidth, .5, 20)) ||
      ![null, 'FRONT', 'BACK', 'LEFT', 'RIGHT'].includes(v.openSide) ||
      !(v.namePrefix === null || text(v.namePrefix, 40)) || !(v.clarification === null || text(v.clarification, 500))) throw new Error('Invalid intent value.');
  if (['region', 'near_marker'].includes(a.type) !== ('marker' in a) || ('marker' in a && !text(a.marker, 100))) throw new Error('A named region or marker is required.');
  if ((a.type === 'along_wall') !== ('wall' in a) || ('wall' in a && !['north', 'south', 'east', 'west'].includes(a.wall))) throw new Error('A valid wall is required.');
  if ((a.type === 'rect') !== ('rect' in a)) throw new Error('A rectangle is required.');
  if (a.rect) {
    const r = object(a.rect, ['minX', 'minZ', 'maxX', 'maxZ']);
    if (Object.values(r).some(n => !number(n, -2000, 2000)) || r.minX >= r.maxX || r.minZ >= r.maxZ) throw new Error('Invalid rectangle.');
  }
  return v as LayoutIntent;
}

export function parseSimple(requirement: string): LayoutIntent {
  const s = requirement.trim();
  const intent: LayoutIntent = { action: 'place', stallSize: { width: 3, length: 3 }, count: null, area: { type: 'whole_hall' }, arrangement: 'rows', aisleWidth: null, openSide: null, namePrefix: null, clarification: null };
  const size = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  const count = s.match(/\b(\d+)\s+(?:stalls?|shops?|booths?)\b/i);
  const wall = s.match(/\b(?:along|on|near)\s+(?:the\s+)?(left|right|top|bottom|north|south|east|west)\s+wall\b/i);
  const marker = s.match(/\bnear\s+([\w-]+)/i);
  if (size) intent.stallSize = { width: +size[1], length: +size[2] };
  if (count) intent.count = +count[1];
  if (wall) intent.area = { type: 'along_wall', wall: ({left:'west',right:'east',top:'north',bottom:'south'}[wall[1].toLowerCase()] ?? wall[1].toLowerCase()) as any };
  else if (marker) intent.area = { type: 'near_marker', marker: marker[1] };
  else if (/\bfoyer\b/i.test(s)) intent.area = { type: 'region', marker: 'foyer' };
  const aisle = s.match(/(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\s+aisles?\b/i);
  if (aisle) intent.aisleWidth = +aisle[1];
  if (/back[ -]to[ -]back/i.test(s)) intent.arrangement = 'back_to_back';
  else if (/\bislands?\b/i.test(s)) intent.arrangement = 'island';
  else if (/\bperimeter\b/i.test(s)) intent.arrangement = 'perimeter';
  const side = s.match(/\b(?:open(?:ing)?|face|facing)\s+(?:to\s+)?(front|back|left|right)\b/i);
  if (side) intent.openSide = side[1].toUpperCase() as LayoutIntent['openSide'];
  if (/^(?:clear|remove|delete)\b/i.test(s)) {
    intent.action = 'clear';
    if (!/\b(?:all|stalls?|shops?|booths?|foyer)\b/i.test(s)) intent.clarification = 'Which stalls should be removed? Say “clear all stalls” or name an area.';
  } else if (!size || !/\b(?:stalls?|shops?|booths?|rows?|fill|place|cut|add|make)\b/i.test(s)) {
    intent.action = 'none'; intent.clarification = 'What stall size and area do you need? For example, “12 stalls of 3x3 along the left wall”.';
  }
  // Do not silently turn an unrecognised location or edit into a whole-hall placement.
  if (/\b(?:move|rotate|resize|except|between)\b/i.test(s) || (/\b(?:near|along|south of|north of)\b/i.test(s) && !wall && !marker)) {
    intent.action = 'none'; intent.clarification = 'The simple parser supports new stalls near a named marker or along a named wall. Could you use that format?';
  }
  try { return validateIntent(intent); } catch { return { ...intent, action: 'none', stallSize: { width: 3, length: 3 }, count: null, aisleWidth: null, clarification: 'Use dimensions from 0.5 to 100 m, a count up to 500, and an aisle up to 20 m.' }; }
}
