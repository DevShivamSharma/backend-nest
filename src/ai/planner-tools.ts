/**
 * The tools the planner's AI assistant may ask for. The server decides which a member is offered
 * (seeing, editing, publishing); the planner in the browser carries them out with the same
 * rule-checked actions its buttons use. Parameters are JSON Schema in the subset Gemini, Groq
 * and Ollama all accept: object, string, number, integer, boolean, array, enum.
 */

/** What a tool needs: `read` anyone who sees the plan, `edit` drawing, `publish` publishing. */
export type ToolAccess = 'read' | 'edit' | 'publish';

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface PlannerTool {
  name: string;
  description: string;
  access: ToolAccess;
  parameters: JsonSchema & { type: 'object' };
}

/** Which booths a tool acts on; the filters combine, and at least one is needed. */
const BOOTHS: JsonSchema = {
  type: 'object',
  description:
    'Which booths: by labels, or by filters that all must match. Use all=true only when the ' +
    'person clearly means every booth.',
  properties: {
    labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Booth labels as shown on the plan, e.g. "A-12" (island A, number 12) or "7".',
    },
    zone: { type: 'string', description: 'Zone name, e.g. "Zone A".' },
    island: { type: 'string', description: 'Island (prefix) of the booth numbers, e.g. "A".' },
    premium: { type: 'boolean' },
    blocked: { type: 'boolean' },
    category: { type: 'string', description: 'Category name the booth sells.' },
    width: { type: 'number', description: 'Booth width in metres.' },
    depth: { type: 'number', description: 'Booth depth in metres.' },
    all: { type: 'boolean', description: 'Every booth on the plan.' },
  },
};

const NONE = { type: 'object' as const, properties: {} };

const num = (description: string): JsonSchema => ({ type: 'number', description });
const str = (description: string): JsonSchema => ({ type: 'string', description });

export const PLANNER_TOOLS: PlannerTool[] = [
  // ---- seeing ----------------------------------------------------------------------------------
  {
    name: 'get_plan_summary',
    access: 'read',
    description:
      'The plan as it is now in the planner, unsaved changes included: hall size, zones with ' +
      'their booths, booth sizes and flags, categories, seats, saved and published versions.',
    parameters: NONE,
  },
  {
    name: 'find_booths',
    access: 'read',
    description: 'Lists booths that match, with label, zone, size, position and flags.',
    parameters: {
      type: 'object',
      properties: { booths: BOOTHS, limit: { type: 'integer', description: 'At most; default 30.' } },
      required: ['booths'],
    },
  },
  {
    name: 'check_rules',
    access: 'read',
    description: "Checks the whole plan against the hall's rules and lists what breaks them.",
    parameters: NONE,
  },
  {
    name: 'show_3d',
    access: 'read',
    description: 'Shows the hall in 3D.',
    parameters: {
      type: 'object',
      properties: { angle: num('Degrees round the hall, 0 = from the front. Optional.') },
    },
  },
  { name: 'show_2d', access: 'read', description: 'Back to the plan from above.', parameters: NONE },
  {
    name: 'focus',
    access: 'read',
    description: 'Zooms the view to a zone or to booths and selects them.',
    parameters: {
      type: 'object',
      properties: { zone: str('Zone name.'), booths: BOOTHS },
    },
  },
  {
    name: 'camera_tour',
    access: 'read',
    description: 'One slow turn of the 3D camera round the hall.',
    parameters: NONE,
  },
  // ---- zones -----------------------------------------------------------------------------------
  {
    name: 'auto_zones',
    access: 'edit',
    description:
      'Divides the open floor into zones on a grid with aisles between them. Only when the plan ' +
      'has no zones yet.',
    parameters: {
      type: 'object',
      properties: { aisle: num("Aisle between zones in metres; default the hall's passage width.") },
    },
  },
  {
    name: 'add_zone',
    access: 'edit',
    description:
      'Adds a rectangular zone. Floor metres, origin at the top-left of the hall, y down.',
    parameters: {
      type: 'object',
      properties: {
        name: str('Zone name; default "Zone N".'),
        x: num('Left edge, metres.'),
        y: num('Top edge, metres.'),
        width: num('Metres.'),
        depth: num('Metres.'),
      },
      required: ['x', 'y', 'width', 'depth'],
    },
  },
  {
    name: 'update_zone',
    access: 'edit',
    description: 'Renames or recolours a zone.',
    parameters: {
      type: 'object',
      properties: {
        zone: str('Current zone name.'),
        name: str('New name.'),
        color: str('Colour as #rrggbb.'),
      },
      required: ['zone'],
    },
  },
  {
    name: 'delete_zone',
    access: 'edit',
    description: 'Deletes a zone; its booths and seats stay, in no zone.',
    parameters: { type: 'object', properties: { zone: str('Zone name.') }, required: ['zone'] },
  },
  // ---- booths ----------------------------------------------------------------------------------
  {
    name: 'auto_booths',
    access: 'edit',
    description:
      'Fills a zone (or every zone, or the whole hall) with booths in rows with aisles, as ' +
      'Auto-booths does. Booths that break a rule are left out.',
    parameters: {
      type: 'object',
      properties: {
        zone: str('Zone name, "all zones", or "hall" for the whole hall. Default: all zones.'),
        width: num('Booth width in metres; default 3.'),
        depth: num('Booth depth in metres; default 3.'),
        aisle: num("Aisle in metres; default the hall's passage width."),
        count: { type: 'integer', description: 'At most this many booths per zone.' },
      },
    },
  },
  {
    name: 'add_booth',
    access: 'edit',
    description: 'Adds one booth at a position. Floor metres, origin top-left, y down.',
    parameters: {
      type: 'object',
      properties: {
        x: num('Left edge.'),
        y: num('Top edge.'),
        width: num('Metres.'),
        depth: num('Metres.'),
        island: str('Island prefix of its number.'),
      },
      required: ['x', 'y', 'width', 'depth'],
    },
  },
  {
    name: 'update_booths',
    access: 'edit',
    description: 'Changes details of booths, as Properties does. Give only what changes.',
    parameters: {
      type: 'object',
      properties: {
        booths: BOOTHS,
        premium: { type: 'boolean' },
        blocked: { type: 'boolean', description: 'Blocked: not for sale.' },
        active: { type: 'boolean' },
        fnb: { type: 'boolean', description: 'Food and beverage.' },
        scheme: { type: 'string', enum: ['shell', 'raw'], description: 'Shell scheme or raw space.' },
        category: str('Category name to sell, or "none" to clear.'),
        open_sides: {
          type: 'array',
          items: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] },
          description: 'Open sides of the booth.',
        },
        description: str('Description text.'),
        island: str('Island prefix of the numbers.'),
      },
      required: ['booths'],
    },
  },
  {
    name: 'move_booths',
    access: 'edit',
    description: 'Moves booths by dx, dy metres (x right, y down).',
    parameters: {
      type: 'object',
      properties: { booths: BOOTHS, dx: num('Metres right.'), dy: num('Metres down.') },
      required: ['booths', 'dx', 'dy'],
    },
  },
  {
    name: 'rotate_booths',
    access: 'edit',
    description: 'Turns each booth a quarter clockwise about its middle.',
    parameters: { type: 'object', properties: { booths: BOOTHS }, required: ['booths'] },
  },
  {
    name: 'mirror_booths',
    access: 'edit',
    description: 'Mirrors booths within the box around them, left-right (x) or top-bottom (y).',
    parameters: {
      type: 'object',
      properties: { booths: BOOTHS, axis: { type: 'string', enum: ['x', 'y'] } },
      required: ['booths', 'axis'],
    },
  },
  {
    name: 'copy_booths',
    access: 'edit',
    description: 'Copies booths beside them to the right, with the next free numbers.',
    parameters: { type: 'object', properties: { booths: BOOTHS }, required: ['booths'] },
  },
  {
    name: 'renumber_booths',
    access: 'edit',
    description: 'Numbers booths from 1 under their island, row by row from the top-left.',
    parameters: { type: 'object', properties: { booths: BOOTHS }, required: ['booths'] },
  },
  {
    name: 'split_booth',
    access: 'edit',
    description: 'Splits one booth in two halves across its longer side.',
    parameters: { type: 'object', properties: { booth: str('Booth label.') }, required: ['booth'] },
  },
  {
    name: 'merge_booths',
    access: 'edit',
    description: 'Joins booths that together fill a rectangle into one.',
    parameters: { type: 'object', properties: { booths: BOOTHS }, required: ['booths'] },
  },
  {
    name: 'delete_booths',
    access: 'edit',
    description: 'Deletes booths. Many at once asks the person first.',
    parameters: { type: 'object', properties: { booths: BOOTHS }, required: ['booths'] },
  },
  // ---- seats and drawings ----------------------------------------------------------------------
  {
    name: 'auto_seats',
    access: 'edit',
    description: 'Fills a zone (or the hall) with rows of seats facing the front.',
    parameters: {
      type: 'object',
      properties: {
        zone: str('Zone name, or "hall".'),
        front: { type: 'string', enum: ['top', 'bottom', 'left', 'right'], description: 'Default top.' },
        count: { type: 'integer', description: 'At most this many seats.' },
        category: str('Category name for the seats.'),
      },
    },
  },
  {
    name: 'delete_seats',
    access: 'edit',
    description: 'Deletes the seats of a zone, or all seats.',
    parameters: {
      type: 'object',
      properties: { zone: str('Zone name; leave out with all=true.'), all: { type: 'boolean' } },
    },
  },
  {
    name: 'add_label',
    access: 'edit',
    description: 'Writes a text label on the plan at a point (metres).',
    parameters: {
      type: 'object',
      properties: { text: str('The text.'), x: num('Metres.'), y: num('Metres.') },
      required: ['text', 'x', 'y'],
    },
  },
  // ---- the plan --------------------------------------------------------------------------------
  {
    name: 'undo',
    access: 'edit',
    description: 'Undoes the last changes.',
    parameters: { type: 'object', properties: { steps: { type: 'integer', description: 'Default 1.' } } },
  },
  {
    name: 'redo',
    access: 'edit',
    description: 'Redoes undone changes.',
    parameters: { type: 'object', properties: { steps: { type: 'integer', description: 'Default 1.' } } },
  },
  { name: 'save', access: 'edit', description: 'Saves the plan as a new version.', parameters: NONE },
  {
    name: 'export_plan',
    access: 'read',
    description: 'Downloads the plan as a file.',
    parameters: NONE,
  },
  {
    name: 'run_full_demo',
    access: 'edit',
    description: 'Opens the setup of the full demo (a new hall, drawn step by step to 3D).',
    parameters: NONE,
  },
  {
    name: 'publish',
    access: 'publish',
    description:
      'Publishes the saved plan to exhibitors. Always asks the person first; save before.',
    parameters: NONE,
  },
];

/** The tools a member is offered. */
export function toolsFor(canEdit: boolean, canPublish: boolean): PlannerTool[] {
  return PLANNER_TOOLS.filter(
    (t) =>
      t.access === 'read' || (t.access === 'edit' && canEdit) || (t.access === 'publish' && canPublish),
  );
}
