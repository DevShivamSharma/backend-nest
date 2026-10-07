/**
 * What the texts printed on a hall floor plan are, in the terms of ITPO's hall layout:
 *  - `icon:*`  a facility, drawn as an icon card beside the hall (`helper_text`);
 *  - `area:*`  a legend row explaining a coloured area of the floor (`legends`);
 *  - `label`   a name printed on the plan: a gate, an exit, a foyer (`exit_labels`);
 *  - `stall_number`, `dimension`, `title`, `none`: kept off the floor entirely.
 *
 * Icons, labels and the legend never become floor geometry: they are placed outside the grid
 * that stalls are drawn on. Only `area:*` legend rows give coloured areas their meaning.
 *
 * Built-in rules know the wording of Indian exhibition plans. A local open-source model reads
 * the rest (other languages and drafting habits); its answers are checked against this list.
 */
export const PLAN_TEXT_KINDS = [
  'icon:toilet-male',
  'icon:toilet-female',
  'icon:toilet',
  'icon:stairs',
  'icon:lift',
  'icon:emergency-exit',
  'icon:entry',
  'icon:cargo-truck',
  'icon:drinking-water',
  'icon:circulation',
  'area:passage',
  'area:fire_curtain',
  'area:no_build',
  'area:column',
  'area:utility',
  'area:unavailable',
  'area:entry',
  'label',
  'stall_number',
  'dimension',
  'title',
  'none',
] as const;

export type PlanTextKind = (typeof PLAN_TEXT_KINDS)[number];

const KNOWN: ReadonlySet<string> = new Set(PLAN_TEXT_KINDS);

export function isPlanTextKind(value: unknown): value is PlanTextKind {
  return typeof value === 'string' && KNOWN.has(value);
}

/** The key a text is looked up by: whitespace collapsed, trimmed. */
export function textKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Texts are cut to this length before anyone reads them. */
export const MAX_TEXT_LENGTH = 120;

/** Distinct texts, in first-seen order, with the empty ones and duplicates removed. */
export function distinctTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const text = textKey(raw).slice(0, MAX_TEXT_LENGTH);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

// --- built-in rules ------------------------------------------------------------------------

/** Words that are only ever facility names, in the languages venues print. Whole text only. */
const FACILITY_WORDS: [RegExp, PlanTextKind][] = [
  // Female first: "female" contains "male".
  [
    /^(toilets?|wc|washrooms?|restrooms?)\s*[\(\[\-–:]?\s*(female|ladies|women|f)\s*[\)\]]?$/,
    'icon:toilet-female',
  ],
  [/^(female|ladies|women'?s?)\s*(toilets?|wc|washrooms?|restrooms?)$/, 'icon:toilet-female'],
  [/^(महिला|स्त्री)\s*(शौचालय|प्रसाधन)$/, 'icon:toilet-female'],
  [
    /^(toilets?|wc|washrooms?|restrooms?)\s*[\(\[\-–:]?\s*(male|gents|men|m)\s*[\)\]]?$/,
    'icon:toilet-male',
  ],
  [/^(male|gents|men'?s?)\s*(toilets?|wc|washrooms?|restrooms?)$/, 'icon:toilet-male'],
  [/^(पुरुष)\s*(शौचालय|प्रसाधन)$/, 'icon:toilet-male'],
  [/^(ladies|women)$/, 'icon:toilet-female'],
  [/^(gents|men)$/, 'icon:toilet-male'],
  [
    /^(toilets?|w\.?c\.?|washrooms?|restrooms?|lavatory|accessible toilet|unisex toilet|शौचालय|प्रसाधन|aseos|toilettes|wc-anlage|卫生间|洗手间|دورة مياه)$/,
    'icon:toilet',
  ],
  [
    /^(lifts?|elevators?|lift lobby|goods lift|service lift|लिफ्ट|ascensor|ascenseur|aufzug|电梯|مصعد)$/,
    'icon:lift',
  ],
  [
    /^(stairs?|staircase|stairway|stairs\s*\/\s*elevators|stairs\s*\/\s*lifts?|escalators?|सीढ़ियाँ|सीढ़ी|escaleras?|escalier|treppe|楼梯|درج)$/,
    'icon:stairs',
  ],
  [
    /^(emergency exits?|fire exits?|fire escape|आपातकालीन निकास|salida de emergencia|sortie de secours|notausgang|安全出口|مخرج طوارئ)$/,
    'icon:emergency-exit',
  ],
  [
    /^(cargo|cargo entry|cargo\s*\/\s*service entry|service entry|service entrance|loading bay|loading dock|goods entry)$/,
    'icon:cargo-truck',
  ],
  [
    /^(drinking water|drinking water point|water point|water cooler|पेयजल|पीने का पानी)$/,
    'icon:drinking-water',
  ],
  [/^(circulation area|circulation)$/, 'icon:circulation'],
  [
    /^(entry|exit|entry\s*\/\s*exit|entrance|main entrance|main entry|in|out|प्रवेश|निकास|entrada|salida|entrée|sortie|eingang|ausgang|入口|出口|مدخل|مخرج)$/,
    'icon:entry',
  ],
];

/**
 * One token of a stall code: "12A", "5G", "06", "A", "HH7A". Letters alone are at most three
 * ("CCF"): a longer word ("STAIR", "LIFT") is a word, not a code.
 */
const STALL_TOKEN = /^([A-Z]{1,3}|[A-Z]{1,4}\d{1,3}[A-Z]{0,2}|\d{1,3}[A-Z]{0,2}\d?|[a-z])$/;

/** "Vending-07", "Outlet-01", "Kiosk 3": a stall series word followed by a number. */
const STALL_SERIES =
  /^(vending|outlet|kiosk|pod|booth|stall|stand|unit|cluster|nozzle|fc|k|p)[\s-]*(\d{1,3}[a-z]?|[a-z])$/i;

function isStallCode(text: string): boolean {
  if (STALL_SERIES.test(text)) return true;
  // Several stalls written together: "95&96", "10,15, & 16", "187 & 193", "03, 07".
  const tokens = text
    .split(/\s*(?:,|&|\/|\band\b)\s*|\s*-\s*|\s+/i)
    .filter((token) => token.length > 0);
  if (!tokens.length || tokens.length > 24) return false;
  if (!tokens.every((token) => STALL_TOKEN.test(token))) return false;
  // At least one number, unless it is one letter or letters only ("B", "b", "B & C").
  return /\d/.test(text) || tokens.every((token) => /^[A-Za-z]$/.test(token));
}

/** Levenshtein distance up to `max`, else `max + 1`. For short words only. */
function nearly(a: string, b: string, max = 1): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length] <= max;
}

/**
 * The kind of a text when the wording leaves no doubt, else undefined. The order matters: a
 * legend row "Fire curtains (No construction zone below)" is a curtain, not a no-build zone,
 * and "FOYER-14F" is a place, not a stall code.
 */
export function ruleKind(raw: string): PlanTextKind | undefined {
  const text = textKey(raw);
  const lower = text.toLowerCase();
  const firstWord = lower.split(/[\s\-–(]/)[0];

  // Sizes and areas. A bare number of 4+ digits is a millimetre dimension; a shorter one is a
  // stall number (ITPO numbers its stalls 1 to 400-odd).
  if (
    /^\d+(\.\d+)?\s*(m|mm|cm|mtrs?|meters?|metres?|m2|m²|sqm|sq\.?\s?m|sq\.?\s?mt|sft|sq\.?\s?ft)$/i.test(
      text,
    )
  )
    return 'dimension';
  if (/^\d+(\.\d+)?\s*[x×*]\s*\d+(\.\d+)?\s*(m|mm|mtrs?)?$/i.test(text)) return 'dimension';
  if (/^\d+\.\d+$/.test(text) || /^\d{4,}$/.test(text)) return 'dimension';
  if (/^\d{1,3}$/.test(text)) return 'stall_number';

  // ITPO's own gate, exit and toilet codes: GF4-1, GG1-2, EE14-3, EE5-01, E1104, E12A01,
  // S12A03, T-4FC, TH11-2/10.
  if (/^(G[FG]|EE)\d{1,2}[A-Z]?-\d{1,2}$/.test(text)) return 'label';
  if (/^[ES]\d{2}[A-Z]?\d{2}$/.test(text)) return 'label';
  if (/^T-?\d{1,2}[GF][A-D]$/.test(text) || /^TH\d{1,2}-\d\/\d{1,2}$/.test(text)) return 'label';

  // Named places, before stall codes. Typos of "foyer" too ("FOVER 5F").
  if (nearly(firstWord, 'foyer') || /^(lobby|concourse|atrium|pre-?function)\b/.test(lower)) {
    return 'label';
  }
  if (
    /^(new\s+)?hall[\s-]*(no\.?\s*)?\d{1,2}[a-z]{0,2}(\s*\((ground|first|second) floor\))?$/.test(
      lower,
    ) ||
    /^entry to hall$|^gate[\s-]*(no\.?\s*)?\d{1,2}$/.test(lower)
  ) {
    return 'label';
  }

  // The drawing's own title block.
  if (
    /\b(floor plan|floor layout|layout plan|site plan|key plan|stall layout|hall layout)\b|\blayout\b.*\b(20\d\d|plan)\b|^scale\b|\bnot to scale\b|dimensions? (are )?in|^drawing (no|title)|^rev(ision)?\.?\s*[a-z]?\d|^legends?$|^north$/.test(
      lower,
    )
  ) {
    return 'title';
  }

  // Legend notes explaining a code ("First digit indicates Hall no.", "GF:", "Gate First Floor").
  if (/\bindicates?\b|\bdigits?\b|\bletters?\b.*\b(no|number)\b/.test(lower)) return 'title';
  if (/^[A-Z0-9][A-Z0-9-]{0,10}:$/.test(text)) return 'title';
  if (/^(gate (ground|first|second) floor|entry or exit gates|service gates?)$/.test(lower)) {
    return 'title';
  }

  for (const [pattern, kind] of FACILITY_WORDS) {
    if (pattern.test(lower)) return kind;
  }
  // Numbered facilities: "STAIR-3", "Lift No. 4", "Escalator 2".
  if (/^(stairs?|staircase|escalators?)[\s.-]*(no\.?\s*)?\d{1,2}[a-z]?$/.test(lower)) {
    return 'icon:stairs';
  }
  if (/^(lifts?|elevators?)[\s.-]*(no\.?\s*)?\d{1,2}[a-z]?$/.test(lower)) return 'icon:lift';

  if (isStallCode(text)) return 'stall_number';
  // A series of special stalls in capitals: "HANGAR-07", "FIRST AID-01", "THEME PAV.-01".
  if (/^[A-Z][A-Z .&]{1,30}-\d{2,3}$/.test(text)) return 'stall_number';

  // Captions of fire-safety symbols, split by CAD into single words ("HOSE" over "REEL"):
  // not texts of the floor. Whole phrases ("Hose Reel") stay legend rows below.
  if (/^(hose|reel|em\.?\s?light|elect\.?|mcp|fhc)$/.test(lower)) return 'none';

  // Legend rows describing an area of the floor.
  if (/fire\s*curtain|smoke\s*curtain/.test(lower)) return 'area:fire_curtain';
  if (/compulsory passage|passage for|^gangway|^aisle|passage \(?\d/.test(lower))
    return 'area:passage';
  if (/no[\s-]?construction|\bnc\b|no[\s-]build/.test(lower)) return 'area:no_build';
  if (/^(structural\s+)?(columns?|pillars?)$/.test(lower)) return 'area:column';
  if (/electric(al)? panels?|hydrants?|hose reel|db box|fire extinguishers?/.test(lower)) {
    return 'area:utility';
  }
  if (/not available for exhibition/.test(lower)) return 'area:unavailable';
  if (/^main entry\s*\/?\s*exit$/.test(lower)) return 'area:entry';

  // ITPO's icon captions that point the way: "Entry from Hall 11", "EXIT TO MLCP".
  if (/^(entry|exit|passage)\s+(from|to)\s+(?!be\b)\S/.test(lower)) return 'icon:entry';

  // Facilities named inside a longer text ("Disabled Toilet", "Mens Toilet Block").
  if (/\b(toilets?|wc|washrooms?|restrooms?|lavatory)\b/.test(lower)) {
    if (/\b(female|ladies|women|womens|women's)\b/.test(lower)) return 'icon:toilet-female';
    if (/\b(male|gents|men|mens|men's)\b/.test(lower)) return 'icon:toilet-male';
    return 'icon:toilet';
  }
  if (/\bstair(s|case|way)?\b|\bescalators?\b/.test(lower)) return 'icon:stairs';
  if (/\b(passenger |goods |service )?(lifts?|elevators?)\b/.test(lower)) return 'icon:lift';
  if (/\bemergency\b.*\bexit\b|\bexit\b.*\bemergency\b|\bfire (exit|escape)\b/.test(lower)) {
    return 'icon:emergency-exit';
  }
  if (
    /\b(cargo|truck|loading|goods|material) (entry|entrance|gate|bay|dock)\b|\bservice gate \(cargo\)/.test(
      lower,
    )
  ) {
    return 'icon:cargo-truck';
  }
  if (/\bdrinking water\b|\bro water\b|\bwater (point|cooler|station|dispenser)\b/.test(lower)) {
    return 'icon:drinking-water';
  }
  if (/^(main|visitors?|exhibitors?|vip|delegates?|public)\s+(entry|entrance|exit)$/.test(lower)) {
    return 'icon:entry';
  }
  if (/\b(main )?aisle\b|\bgangways?\b|\bfire lane\b/.test(lower)) return 'area:passage';
  if (/निर्माण निषिद्ध/.test(text)) return 'area:no_build';
  if (/\bpower point\b/.test(lower)) return 'area:utility';
  if (/not for exhibition/.test(lower)) return 'area:unavailable';

  // Rooms and offices: places, printed as labels.
  if (
    /\b(room|office|lounge|hall \d+|desk|centre|center|court|registration|pantry|store|cloak ?room|reception|cafeteria|canteen|garden|first aid)\b/.test(
      lower,
    )
  ) {
    return 'label';
  }
  return undefined;
}

// --- asking a model --------------------------------------------------------------------------

/** How many texts go into one request. Small models stay accurate on short lists. */
export const TEXTS_PER_REQUEST = 15;

/** At most this much of the importer's own instructions is passed on. */
export const MAX_INSTRUCTIONS = 1000;

export const PLAN_TEXT_SYSTEM_PROMPT = `You classify the text labels printed on an exhibition hall floor plan.
Plans come from any country and drafting style, in any language.
For every numbered text, in the same order, copy the text exactly and give its one kind:
- icon:toilet-male, icon:toilet-female, icon:toilet: a toilet facility (any language: WC, Aseos, शौचालय, 卫生间).
- icon:stairs: stairs, staircase or escalator. icon:lift: a lift or elevator.
- icon:emergency-exit: an emergency or fire exit. icon:entry: a way in or out ("Entry", "Exit", "Entrance", "Entry from Hall 11").
- icon:cargo-truck: a cargo, loading or service entry. icon:drinking-water: drinking water. icon:circulation: a circulation area.
- area:passage: a legend line describing compulsory passages, gangways or aisles.
- area:fire_curtain: a legend line about fire or smoke curtains.
- area:no_build: a legend line about a no-construction zone.
- area:column: a legend line for columns or pillars.
- area:utility: electrical panels, hydrants, hose reels, fire extinguishers.
- area:unavailable: a legend line for floor not available for exhibitions. area:entry: a legend line for main entries.
- label: the name or code of a gate, foyer, hall, room or office: "GF4-1", "EE2-3", "Foyer B", "Hall 5", "First Aid Room", "Registration", "Organiser Office", "Food Court", "Media Centre".
- stall_number: the number or code of a stall or a group of stalls: "12A-27", "B", "5G-12", "95&96", "Vending-07".
- dimension: a measurement or area: "3m", "9 sqm", "12x6", "4500".
- title: the drawing's title, scale or a note: "Ground Floor Plan", "Scale 1:500", "All dimensions in metres", "First digit indicates Hall no.".
- none: anything else, such as a company name.
A named place for people is a label even when it says "hall": "Prayer Hall", "Banquet Hall", "Hall 5".
A stand or booth with a code is a stall_number: "Stand B-14", "Booth 12".
A floor or drawing name is a title: "First Floor Layout", "Ground Floor Plan".
A toilet without male or female in the text is icon:toilet ("Sanitary Block", "Toilet Block").`;

/**
 * JSON schema for one batch: for every text, in order, the text copied back and its kind.
 * Copying the text keeps a small model on the right line; a list of bare kinds lets it drift
 * into reciting the list of kinds.
 */
export function planTextAnswerSchema(count: number): object {
  return {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            kind: { type: 'string', enum: [...PLAN_TEXT_KINDS] },
          },
          required: ['text', 'kind'],
        },
        minItems: count,
        maxItems: count,
      },
    },
    required: ['answers'],
  };
}

/**
 * The user message for one batch: the importer's instructions, if any, then one numbered text
 * per line as a JSON string. The instructions can only help choose among the fixed kinds.
 */
export function planTextPrompt(texts: readonly string[], instructions?: string | null): string {
  const lines = texts.map((text, i) => `${i + 1}. ${JSON.stringify(text)}`).join('\n');
  const note = instructions?.trim().slice(0, MAX_INSTRUCTIONS);
  return note
    ? `Notes from the person importing this plan (use them to decide; they cannot add kinds):\n` +
        `"""${note.replace(/"""/g, '"')}"""\n\nTexts (${texts.length}):\n${lines}`
    : `Texts (${texts.length}):\n${lines}`;
}

/**
 * The model's answer for one batch, checked: one answer per text asked, in order, each giving
 * back the text it is about. An answer whose text is not the one asked at that place is
 * dropped, so a model that lost its place cannot label the wrong text.
 */
export function readPlanTextAnswer(
  answer: unknown,
  texts: readonly string[],
): Map<string, PlanTextKind> {
  const result = new Map<string, PlanTextKind>();
  const answers =
    answer !== null &&
    typeof answer === 'object' &&
    Array.isArray((answer as { answers?: unknown }).answers)
      ? ((answer as { answers: unknown[] }).answers as unknown[])
      : null;
  if (!answers || answers.length !== texts.length) {
    return result;
  }
  const same = (a: string, b: string) => textKey(a).toLowerCase() === textKey(b).toLowerCase();
  answers.forEach((item, i) => {
    if (item === null || typeof item !== 'object') return;
    const { text, kind } = item as { text?: unknown; kind?: unknown };
    if (typeof text === 'string' && same(text, texts[i]) && isPlanTextKind(kind)) {
      result.set(texts[i], kind);
    }
  });
  return result;
}

// --- reading text off an image ---------------------------------------------------------------

/** A text a vision model read off a plan image, with its box in image pixels. */
export interface ImageText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IMAGE_TEXT_PROMPT = `This is an exhibition hall floor plan. List every text printed on it:
gate and exit codes, facility names, legend lines, room names, numbers.
For each, give the exact text and its bounding box in pixels of this image: x and y of the
top-left corner, width and height. Do not describe the drawing. Do not translate.`;

export const IMAGE_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['text', 'x', 'y', 'width', 'height'],
      },
    },
  },
  required: ['texts'],
} as const;

/** The vision model's answer, checked: boxes inside the image, texts not empty. */
export function readImageTextAnswer(
  answer: unknown,
  image: { width: number; height: number },
): ImageText[] {
  const raw =
    answer !== null &&
    typeof answer === 'object' &&
    Array.isArray((answer as { texts?: unknown }).texts)
      ? ((answer as { texts: unknown[] }).texts as unknown[])
      : [];
  const out: ImageText[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const text = typeof t['text'] === 'string' ? textKey(t['text']).slice(0, MAX_TEXT_LENGTH) : '';
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((k) => Number(t[k]));
    const box = [x, y, width, height];
    if (!text || box.some((v) => !Number.isFinite(v)) || width <= 0 || height <= 0) continue;
    if (x < 0 || y < 0 || x + width > image.width * 1.01 || y + height > image.height * 1.01) {
      continue;
    }
    out.push({ text, x, y, width, height });
  }
  return out;
}
