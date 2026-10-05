import { parseCopyTables, sourceMaster, type SourceRate } from './pricing-library';

const rate = (): SourceRate => ({ id: '12345678-example', eventId: 'event', eventName: 'IITF 2026', eventLabel: 'IITF 2026',
  hallName: 'Hall 12A', venueHallId: '12', category: 'General', isTest: false, issues: [], source: {
    bare_rate: '17100', shell_rate: null, two_side_open_rate_percent: '10', three_side_open_rate_percent: '15',
    four_side_open_rate_percent: '20', catlog_entry_charge: '0', corner_charges_applicable: 't',
    start_date: '2026-09-14 11:00:00+05:30', end_date: '2026-10-31 11:00:00+05:30',
  } });

describe('dump pricing preservation', () => {
  it('keeps COPY null distinct from a literal backslash N and decodes escaped text', () => {
    const sql = 'COPY idp."T_EXAMPLE" (id, value) FROM stdin;\n1\t\\N\n2\t\\\\N\n3\tLine\\nTwo\\tX\n\\.\n';
    expect(parseCopyTables(sql).T_EXAMPLE.map(r => r.value)).toEqual([null, '\\N', 'Line\nTwo\tX']);
  });
  it('refuses malformed COPY rows', () => expect(() => parseCopyTables('COPY idp."T" (id, value) FROM stdin;\n1\n\\.')).toThrow());
  it('keeps an unavailable shell rate and explicit free bare rate distinct', () => {
    const r = rate(); r.source.bare_rate = '0';
    expect(sourceMaster(r)).toMatchObject({ bare_rate: 0, shell_rate: null, tax_mode: 'NONE', emc_markup_percent: 0 });
  });
  it('does not promote unresolved or special rates to quoteable masters', () => {
    const r = rate(); r.issues = ['F&B basis needs confirmation']; expect(sourceMaster(r)).toBeNull();
  });
  it('retains the hall-specific premium and limits names', () => {
    const r = rate(); r.hallName = 'Hall '.repeat(50);
    expect(sourceMaster(r)!.name.length).toBeLessThanOrEqual(120);
    expect(sourceMaster(r)!.three_side_open_rate_percent).toBe(15);
  });
});
