import { BASIC_RULE_IDS, type BasicRuleId } from '../placement/basic-rules';

/**
 * Hall-rule changes the user asked for ("set passages to 4 m", "turn off wall clearance", "add a
 * rule: corner stalls are premium"). A proposal only: the planner applies it after review.
 * passageWidth is for the layout's event type; notes become planner rules (free text).
 */
export interface RuleChanges {
  enable: BasicRuleId[];
  disable: BasicRuleId[];
  passageWidth: number | null;
  wallClearance: number | null;
  notes: string[];
}

export interface LayoutIntent {
  action: 'place' | 'clear' | 'none' | 'rules';
  stallSize: { width: number; length: number };
  count: number | null;
  area: { type: 'whole_hall' | 'region' | 'near_marker' | 'along_wall' | 'rect'; marker?: string; wall?: 'north' | 'south' | 'east' | 'west'; rect?: { minX: number; minZ: number; maxX: number; maxZ: number } };
  arrangement: 'rows' | 'back_to_back' | 'island' | 'perimeter';
  aisleWidth: number | null;
  openSide: 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT' | null;
  namePrefix: string | null;
  clarification: string | null;
  /** Only with action "rules"; absent or null otherwise. */
  rules?: RuleChanges | null;
}

const choice = (values: string[]) => ({ type: 'STRING', enum: values });
export const INTENT_SCHEMA = {
  type: 'OBJECT', required: ['action', 'stallSize', 'count', 'area', 'arrangement', 'aisleWidth', 'openSide', 'namePrefix', 'clarification'],
  properties: {
    action: choice(['place', 'clear', 'none', 'rules']),
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
    namePrefix: { type: 'STRING', nullable: true }, clarification: { type: 'STRING', nullable: true },
    rules: { type: 'OBJECT', nullable: true, required: ['enable', 'disable', 'passageWidth', 'wallClearance', 'notes'], properties: {
      enable: { type: 'ARRAY', items: choice([...BASIC_RULE_IDS]) }, disable: { type: 'ARRAY', items: choice([...BASIC_RULE_IDS]) },
      passageWidth: { type: 'NUMBER', nullable: true }, wallClearance: { type: 'NUMBER', nullable: true },
      notes: { type: 'ARRAY', items: { type: 'STRING' } }
    } }
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
const ruleIds = (v: unknown) => Array.isArray(v) && v.length <= BASIC_RULE_IDS.length && new Set(v).size === v.length &&
  v.every(id => (BASIC_RULE_IDS as readonly unknown[]).includes(id));
function validateRules(raw: unknown): RuleChanges {
  const r = object(raw, ['enable', 'disable', 'passageWidth', 'wallClearance', 'notes']);
  // Passage widths follow the hall rules' own 3-5 m limit; notes become planner rules.
  if (!ruleIds(r.enable) || !ruleIds(r.disable) || r.enable.some((id: string) => r.disable.includes(id)) ||
      !(r.passageWidth === null || number(r.passageWidth, 3, 5)) || !(r.wallClearance === null || number(r.wallClearance, 0, 10)) ||
      !Array.isArray(r.notes) || r.notes.length > 5 || r.notes.some((n: unknown) => !text(n, 300))) throw new Error('Invalid rule changes.');
  if (!r.enable.length && !r.disable.length && r.passageWidth === null && r.wallClearance === null && !r.notes.length) throw new Error('No rule changes.');
  return r as RuleChanges;
}
export function validateIntent(raw: unknown): LayoutIntent {
  const v = object(raw, INTENT_SCHEMA.required, ['rules']);
  const size = object(v.stallSize, ['width', 'length']);
  const a = object(v.area, ['type'], ['marker', 'wall', 'rect']);
  if (!['place', 'clear', 'none', 'rules'].includes(v.action) || !number(size.width, .5, 100) || !number(size.length, .5, 100) ||
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
  // A stall action never carries rule changes: models often echo an empty rules object, so it is
  // dropped rather than failing an otherwise valid stall request.
  if (v.action === 'rules') v.rules = v.clarification === null ? validateRules(v.rules) : null;
  else delete v.rules;
  return v as LayoutIntent;
}

export function parseSimple(requirement: string): LayoutIntent {
  const s = requirement.trim();
  const intent: LayoutIntent = { action: 'place', stallSize: { width: 3, length: 3 }, count: null, area: { type: 'whole_hall' }, arrangement: 'rows', aisleWidth: null, openSide: null, namePrefix: null, clarification: null };
  const size = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  const count = s.match(/\b(\d+)\s+(?:stalls?|shops?|booths?)\b/i);
  const wall = s.match(/\b(?:along|on|near)\s+(?:the\s+)?(left|right|top|bottom|north|south|east|west)\s+wall\b/i);
  const marker = s.match(/\bnear\s+([\w-]+)/i);
  // Rule requests: a passage width, a wall clearance, or a new written rule ("add rule: ...").
  const passage = s.match(/\bpassages?(?:\s+width)?\s+(?:to\s+|of\s+|=\s*)?(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/i);
  const clearance = s.match(/\bwall\s+clearance\s+(?:to\s+|of\s+|=\s*)?(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/i);
  const note = s.match(/^(?:add|create|new)\s+(?:a\s+)?(?:planner\s+)?rules?\b\s*[:\-–]?\s*(.+)$/i);
  if ((passage || clearance || note) && !count) {
    const rules: RuleChanges = { enable: [], disable: [], passageWidth: passage ? +passage[1] : null, wallClearance: clearance ? +clearance[1] : null, notes: note && !passage && !clearance ? [note[1].trim().slice(0, 300)] : [] };
    try { return validateIntent({ ...intent, action: 'rules', rules }); }
    catch { return { ...intent, action: 'none', clarification: 'Passage widths must be 3–5 m and wall clearance 0–10 m.' }; }
  }
  // About rules but with no change this parser can read ("i want to add rules"): ask about rules, not stall sizes.
  if (/\b(?:rule|passage|clearance)/i.test(s) && !count && !size)
    return { ...intent, action: 'none', clarification: 'Which rule should change? For example “Set the passage width to 4 m”, “Wall clearance 1 m” or “Add rule: corner stalls are premium”.' };
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
