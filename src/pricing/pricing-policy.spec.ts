import { validateMaster, quoteStall, type PricingSnapshot } from './pricing-policy';
import { moneyProduct } from './money';

const input = { name: 'Test only', bare_rate: 100, tax_mode: 'NONE' };
const snapshot = (extra = {}): PricingSnapshot => {
  const { name, ...policy } = validateMaster({ ...input, ...extra });
  return { masterId: 1, name, revision: 1, policy };
};
describe('price policies and quotes', () => {
  it('distinguishes an unavailable rate from an explicit free rate', () => {
    const p = snapshot({ bare_rate: 0 });
    expect(p.policy.shell_rate).toBeNull();
    expect(quoteStall(p, 1, 'S1', 9, 1, 'bare').total).toBe(0);
    expect(() => quoteStall(p, 1, 'S1', 9, 1, 'shell')).toThrow('No shell rate');
    expect(() => validateMaster({ name:'Empty', tax_mode:'NONE' })).toThrow('at least one');
  });
  it.each([-1, Infinity, NaN, '100', 10_000_001, 1.123])('rejects invalid rates: %s', rate => {
    expect(() => validateMaster({ ...input, bare_rate:rate })).toThrow();
  });
  it.each([
    { tax_mode:'NONE', igst_percent:18 },
    { tax_mode:'IGST', cgst_percent:9 },
    { tax_mode:'CGST_SGST', igst_percent:18 },
    { tax_mode:'OTHER' },
    { emc_taxable:'true' },
    { emc_markup_percent:101 },
    { unknown_column:0 },
  ])('rejects contradictory/invalid policy %j', extra => {
    expect(() => validateMaster({ ...input,...extra })).toThrow();
  });
  it('reuses the SelfCare formula and itemises EMC with its explicit tax setting', () => {
    const p=snapshot({ two_side_open_rate_percent:10, catlog_entry_charge:50,
      tax_mode:'CGST_SGST',cgst_percent:9,sgst_percent:9,emc_markup_percent:5,emc_fixed_charge:25,emc_taxable:true });
    expect(quoteStall(p,1,'S1',9,2,'bare')).toMatchObject({ rental:900, openSideCharge:90,
      catalogueCharge:50,subtotal:1040,baseTax:187.2,baseTotal:1227.2,emcCharge:77,emcTax:13.86,total:1318.06 });
    expect(quoteStall({...p,policy:{...p.policy,emc_taxable:false}},1,'S1',9,2,'bare').total).toBe(1304.2);
  });
  it('rounds decimal products and half-paise cases accurately', () => {
    expect(moneyProduct(1.5,0.67)).toBe(1.01);
    expect(moneyProduct(20.1,0.05)).toBe(1.01);
    expect(moneyProduct(1e-7,100_000)).toBe(0.01);
    expect(quoteStall(snapshot({bare_rate:0.67}),1,'S1',1.5,1,'bare').rental).toBe(1.01);
  });
  it.each([[2,10],[3,20],[4,30],[6,30]])('uses the correct premium for %s open edges', (sides,percent) => {
    const p=snapshot({two_side_open_rate_percent:10,three_side_open_rate_percent:20,four_side_open_rate_percent:30});
    expect(quoteStall(p,1,'S1',1,sides,'bare').openSideCharge).toBe(percent);
  });
  it('binds the fingerprint to the exact revision, stall, geometry and scheme', () => {
    const p=snapshot({ shell_rate:100 });
    const initial=quoteStall(p,1,'S1',9,1,'bare').fingerprint;
    for(const q of [quoteStall({...p,revision:2},1,'S1',9,1,'bare'), quoteStall(p,1,'S2',9,1,'bare'),
      quoteStall(p,1,'S1',10,1,'bare'),quoteStall(p,1,'S1',9,2,'bare'),quoteStall(p,1,'S1',9,1,'shell')]) expect(q.fingerprint).not.toBe(initial);
    expect(quoteStall(p,1,'S1',9,1,'bare').fingerprint).toBe(initial);
  });
});
