import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { moneyProduct } from './money';
import { selfcareBooking, type SelfcareBookingInput } from '../layouts/selfcare-booking';

/** Rates are INR per square metre; fixed charges are INR per stall. */
export interface PricePolicy {
  bare_rate: number | null;
  shell_rate: number | null;
  two_side_open_rate_percent: number;
  three_side_open_rate_percent: number;
  four_side_open_rate_percent: number;
  catlog_entry_charge: number;
  tax_mode: 'NONE' | 'CGST_SGST' | 'IGST';
  cgst_percent: number;
  sgst_percent: number;
  igst_percent: number;
  emc_name: string;
  emc_markup_percent: number;
  emc_fixed_charge: number;
  emc_taxable: boolean;
}
export interface PriceMasterInput extends PricePolicy { name: string; }
export interface PricingSnapshot {
  masterId: number;
  name: string;
  revision: number;
  policy: PricePolicy;
}
export interface StallQuote {
  fingerprint: string;
  layoutId: number;
  stallNumber: string;
  stallType: 'bare' | 'shell';
  currency: 'INR';
  masterName: string;
  revision: number;
  area: number;
  openSides: number;
  rate: number;
  rental: number;
  openSideCharge: number;
  catalogueCharge: number;
  subtotal: number;
  baseTax: number;
  baseTotal: number;
  emcName: string;
  emcCharge: number;
  emcTax: number;
  total: number;
}

export function validateMaster(value: unknown): PriceMasterInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a price master.');
  const row = value as Record<string, unknown>;
  const name = label(row.name, 'Name', 120);
  if (!name) fail('Name is required.');
  const modes = ['NONE', 'CGST_SGST', 'IGST'];
  if (!modes.includes(String(row.tax_mode))) fail('Choose a tax mode: NONE, CGST_SGST or IGST.');
  const number = (key: string, nullable = false): number | null => {
    const v = row[key];
    if (v === null || v === undefined || v === '') return nullable ? null : 0;
    const max = key.endsWith('percent') ? 100 : 10_000_000;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || Math.abs(v * 100 - Math.round(v * 100)) > 0.000001)
      fail(`${key}: enter a number from 0 to ${max}, with at most 2 decimal places.`);
    return v as number;
  };
  const policy: PriceMasterInput = {
    name, bare_rate: number('bare_rate', true), shell_rate: number('shell_rate', true),
    two_side_open_rate_percent: number('two_side_open_rate_percent')!,
    three_side_open_rate_percent: number('three_side_open_rate_percent')!,
    four_side_open_rate_percent: number('four_side_open_rate_percent')!,
    catlog_entry_charge: number('catlog_entry_charge')!,
    tax_mode: row.tax_mode as PricePolicy['tax_mode'],
    cgst_percent: number('cgst_percent')!, sgst_percent: number('sgst_percent')!, igst_percent: number('igst_percent')!,
    emc_name: label(row.emc_name ?? '', 'EMC name', 120),
    emc_markup_percent: number('emc_markup_percent')!, emc_fixed_charge: number('emc_fixed_charge')!,
    emc_taxable: row.emc_taxable === true,
  };
  for (const key of Object.keys(row)) if (!(key in policy)) fail(`Unknown column: ${key}.`);
  if (row.emc_taxable !== undefined && typeof row.emc_taxable !== 'boolean') fail('emc_taxable must be true or false.');
  if (policy.bare_rate === null && policy.shell_rate === null) fail('Enter at least one bare or shell rate. Blank means unavailable; 0 means free.');
  if (policy.tax_mode === 'NONE' && (policy.cgst_percent || policy.sgst_percent || policy.igst_percent)) fail('NONE requires all tax percentages to be 0.');
  if (policy.tax_mode === 'IGST' && (policy.cgst_percent || policy.sgst_percent)) fail('IGST cannot be combined with CGST or SGST.');
  if (policy.tax_mode === 'CGST_SGST' && policy.igst_percent) fail('CGST/SGST cannot be combined with IGST.');
  return policy;
}

export function selfcarePriceInput(p: PricePolicy, type: 'bare' | 'shell'): SelfcareBookingInput {
  return { stall_type: type, pricing: { ...p, corner_charges_applicable: true }, tax: p };
}

/** The SelfCare base formula remains shared; EMC is a separate charge, never silently folded into it. */
export function quoteStall(snapshot: PricingSnapshot, layoutId: number, stallNumber: string,
  area: number, openSides: number, stallType: unknown): StallQuote {
  if (stallType !== 'bare' && stallType !== 'shell') fail('Choose bare or shell.');
  const type = stallType as 'bare' | 'shell';
  const p = snapshot.policy;
  if (p[`${type}_rate`] === null) fail(`No ${type} rate is configured for this layout.`);
  if (!Number.isFinite(area) || area <= 0 || area > 1_000_000) fail('Stall area is outside the pricing limits.');
  const base = selfcareBooking({ name: '', area, openSides }, selfcarePriceInput(p, type)).T_STALL_BOOKING_DETAIL[0];
  const subtotal = base.total!;
  const emcCharge = money(moneyProduct(subtotal, p.emc_markup_percent, 100) + p.emc_fixed_charge);
  const emcTax = !p.emc_taxable ? 0 : p.tax_mode === 'IGST' ? moneyProduct(emcCharge, p.igst_percent, 100)
    : money(moneyProduct(emcCharge, p.cgst_percent, 100) + moneyProduct(emcCharge, p.sgst_percent, 100));
  const amounts = { layoutId, stallNumber, stallType: type, currency: 'INR' as const,
    masterName: snapshot.name, revision: snapshot.revision, area, openSides,
    rate: base.rate!, rental: base.rental!, openSideCharge: base.corner_charge!, catalogueCharge: base.catalog_charge!,
    subtotal, baseTax: base.total_gst_amount!, baseTotal: base.net_payable_amount!,
    emcName: p.emc_name, emcCharge, emcTax, total: money(base.net_payable_amount! + emcCharge + emcTax) };
  if (amounts.total > 1_000_000_000_000) fail('Quote exceeds the supported amount.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ snapshot, amounts })).digest('hex');
  return { fingerprint, ...amounts };
}
function money(v: number): number { return Math.round((v + Number.EPSILON) * 100) / 100; }
function label(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length > max) fail(`${name} must be text, up to ${max} characters.`);
  return (v as string).trim();
}
function fail(message: string): never { throw new BadRequestException(message); }
