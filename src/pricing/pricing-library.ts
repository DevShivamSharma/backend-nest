import { validateMaster, type PriceMasterInput } from './pricing-policy';

export type SourceRow = Record<string, string | null>;
export interface SourceRate {
  id: string; eventId: string; eventName: string; eventLabel: string;
  hallName: string; venueHallId: string | null; category: string;
  isTest: boolean; issues: string[]; source: SourceRow;
  masterId?: number; masterName?: string;
}

/** Parse COPY text emitted by pg_restore; SQL is never executed. */
export function parseCopyTables(sql: string): Record<string, SourceRow[]> {
  const tables: Record<string, SourceRow[]> = {};
  for (const match of sql.matchAll(/COPY idp\."([^"]+)" \((.*?)\) FROM stdin;\r?\n([\s\S]*?)\r?\n\\\./g)) {
    const columns = match[2].split(',').map(c => c.trim().replaceAll('"', ''));
    tables[match[1]] = match[3].split(/\r?\n/).filter(Boolean).map(line => {
      const values = line.split('\t');
      if (values.length !== columns.length) throw new Error(`Invalid COPY row in ${match[1]}`);
      return Object.fromEntries(columns.map((c, i) => [c, values[i] === '\\N' ? null : values[i].replace(
        /\\([btnrfv\\]|[0-7]{1,3})/g,
        (_, v: string) => ({ b: '\b', t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', '\\': '\\' }[v] ?? String.fromCharCode(parseInt(v, 8))),
      )]));
    });
  }
  return tables;
}

function shortEvent(name: string): string {
  const year = name.match(/20\d{2}/)?.[0] ?? '';
  if (/AAHAR/i.test(name)) return `AAHAR ${year}`;
  if (/IITF/i.test(name)) return `IITF ${year}`;
  if (/LEATHER FAIR/i.test(name)) return `IILF ${year}`;
  if (/Footwear Fair/i.test(name)) return `IIFF ${year}`;
  if (/World Book Fair/i.test(name)) return `Book Fair ${year}`;
  if (/Nakshatra/i.test(name)) return `Nakshatra ${year}`;
  if (/demo|testing/i.test(name)) return 'Source test event';
  return name.slice(0, 22);
}

export function buildPricingLibrary(tables: Record<string, SourceRow[]>) {
  for (const name of ['T_STALL_PRICE_MASTER', 'T_EVENT_HALL', 'T_HALL_BOOKING', 'T_HALLS', 'T_HALLS_PRICE', 'T_HALLS_CATEGORY']) {
    if (!tables[name]) throw new Error(`Dump is missing ${name}`);
  }
  const halls = new Map(tables.T_EVENT_HALL.map(r => [r.id, r]));
  const events = new Map(tables.T_HALL_BOOKING.map(r => [r.id, r]));
  const categories = new Map(tables.T_HALLS_CATEGORY.map(r => [r.id, r.category_name]));
  const stallRates: SourceRate[] = tables.T_STALL_PRICE_MASTER.map(source => {
    const hall = halls.get(source.hall_id), event = events.get(source.event_id);
    const eventName = event?.event_name?.trim() || `Unmapped event ${source.event_id?.slice(0, 8)}`;
    const rate: SourceRate = {
      id: source.id!, eventId: source.event_id!, eventName, eventLabel: shortEvent(eventName),
      hallName: hall?.hall_name || `Unmapped hall ${source.hall_id?.slice(0, 8)}`,
      venueHallId: hall?.hall_id ?? null, category: source.applicable_to || 'Unspecified',
      isTest: /demo|testing/i.test(eventName), issues: [], source,
    };
    if (!hall) rate.issues.push('Hall mapping missing');
    if (hall && hall.booking_id !== source.event_id) rate.issues.push('Hall belongs to a different event');
    if (!event) rate.issues.push('Event mapping missing');
    if (rate.isTest) rate.issues.push('Source test event');
    if (source.status !== '1') rate.issues.push('Source rate is inactive');
    if (source.is_fnb_stall === 't') rate.issues.push('F&B basis needs confirmation');
    if (source.bare_rate === null && source.shell_rate === null) rate.issues.push('No bare or shell rate');
    if (source.catlog_entry_charge === null) rate.issues.push('Catalogue charge unspecified');
    if (source.corner_charges_applicable !== 'f' && ['two_side_open_rate_percent', 'three_side_open_rate_percent', 'four_side_open_rate_percent'].some(k => source[k] === null)) rate.issues.push('Open-side premium unspecified');
    return rate;
  });
  const schedules = tables.T_HALLS_PRICE.map(r => ({
    id: r.id, categoryId: r.hall_category_id, categoryName: categories.get(r.hall_category_id) ?? 'Unmapped category',
    period: r.period_name, validFrom: r.period_start_date, validTo: r.period_end_date, active: r.is_active === 't',
    mounting: r.mounting_price, exhibition: r.exhibition_price, dismantling: r.dismantling_price,
    fnbMounting: r.fnb_mounting_price, fnbExhibition: r.fnb_exhibition_price, fnbDismantling: r.fnb_dismantling_price,
    ticketedMounting: r.ticketed_mounting_amount, ticketedExhibition: r.ticketed_exhibition_amount, ticketedDismantling: r.ticketed_dismantling_amount,
  }));
  const hallRentals = tables.T_HALLS.map(r => ({
    id: r.id, name: r.name, active: r.is_active === 't', categoryId: r.hall_category_id,
    categoryName: categories.get(r.hall_category_id) ?? 'Unmapped category',
    additionalChargesPercent: tables.T_HALLS_CATEGORY.find(c => c.id === r.hall_category_id)?.additional_charges_percent ?? null,
    discountPercent: tables.T_HALLS_CATEGORY.find(c => c.id === r.hall_category_id)?.discount_percent ?? null,
    scheduleIds: schedules.filter(s => s.categoryId === r.hall_category_id).map(s => s.id),
  }));
  return { sourceName: 'p-db', stallRates, schedules, hallRentals };
}

/** Only mapped, unambiguous domestic stall rates become editable per-m² masters. */
export function sourceMaster(rate: SourceRate): PriceMasterInput | null {
  if (rate.issues.length) return null;
  const s = rate.source;
  const period = `${s.start_date?.slice(0, 10) ?? 'undated'} to ${s.end_date?.slice(0, 10) ?? 'open'}`;
  const name = `DB demo ${rate.eventLabel} ${rate.hallName} ${rate.category} ${period}`.slice(0, 96) + ` ${rate.id.slice(0, 8)} pre-tax`;
  const number = (key: string) => s[key] === null ? null : Number(s[key]);
  return validateMaster({ name, bare_rate: number('bare_rate'), shell_rate: number('shell_rate'),
    two_side_open_rate_percent: s.corner_charges_applicable === 'f' ? 0 : number('two_side_open_rate_percent'),
    three_side_open_rate_percent: s.corner_charges_applicable === 'f' ? 0 : number('three_side_open_rate_percent'),
    four_side_open_rate_percent: s.corner_charges_applicable === 'f' ? 0 : number('four_side_open_rate_percent'),
    catlog_entry_charge: number('catlog_entry_charge'), tax_mode: 'NONE', cgst_percent: 0, sgst_percent: 0, igst_percent: 0,
    emc_name: '', emc_markup_percent: 0, emc_fixed_charge: 0, emc_taxable: false,
  });
}
