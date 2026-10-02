import { selfcareBooking, splitStallName } from './selfcare-booking';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const pricing = {
  bare_rate: 16000,
  shell_rate: 17600,
  two_side_open_rate_percent: 10,
  three_side_open_rate_percent: 15,
  four_side_open_rate_percent: 18,
  catlog_entry_charge: 0,
  corner_charges_applicable: true,
};

describe('selfcareBooking', () => {
  it('reproduces a SelfCare booking line to the paisa', () => {
    // A real T_STALL_BOOKING_DETAIL row: 16 m² shell, 2 open sides, 9 % + 9 % GST.
    const line = selfcareBooking(
      { name: '12A-17 A', area: 16, openSides: 2 },
      { stall_type: 'shell', pricing, tax: { cgst_percent: 9, sgst_percent: 9, igst_percent: null } },
      NOW,
    ).T_STALL_BOOKING_DETAIL[0];
    expect(line).toMatchObject({
      rate: 17600,
      rental: 281600,
      corner_charge: 28160,
      catalog_charge: 0,
      total: 309760,
      cgst_amount: 27878.4,
      sgst_amount: 27878.4,
      igst: 0,
      total_gst_amount: 55756.8,
      net_payable_amount: 365516.8,
    });
  });

  it('writes the pre-payment state SelfCare uses, held for an hour', () => {
    const payload = selfcareBooking({ name: '12A-17 A', area: 12, openSides: 1 }, { hall_id: 67 }, NOW);
    expect(payload.T_STALLS).toEqual({
      id: null,
      hall_id: 67,
      island_number: '12A-17',
      stall_number: 'A',
      booking_status: 'In-Progress',
      no_of_open_sides: 1,
    });
    expect(payload.T_STALL_BOOKING).toMatchObject({
      booking_status: 'Pending',
      payment_status: 'Pending',
      valid_till: '2026-10-02T11:00:00.000Z',
    });
    expect(payload.T_STALL_BOOKING_DETAIL[0].status).toBe('In-Progress');
  });

  it('leaves every amount empty without a stall type and price', () => {
    const line = selfcareBooking({ name: 'A1', area: 12, openSides: 1 }, { pricing }, NOW).T_STALL_BOOKING_DETAIL[0];
    expect([line.rate, line.total, line.net_payable_amount]).toEqual([null, null, null]);
    expect(line.area).toBe(12);
  });

  it('uses IGST instead of CGST + SGST when it is given', () => {
    const line = selfcareBooking(
      { name: 'X 1', area: 10, openSides: 1 },
      { stall_type: 'bare', pricing, tax: { cgst_percent: 9, sgst_percent: 9, igst_percent: 18 } },
      NOW,
    ).T_STALL_BOOKING_DETAIL[0];
    expect([line.total, line.igst, line.cgst_amount, line.net_payable_amount]).toEqual([160000, 28800, 0, 188800]);
  });

  it('splits a stall name into island and stall number', () => {
    expect(splitStallName('12A-17 A')).toEqual({ island: '12A-17', letter: 'A' });
    expect(splitStallName('Stall s28')).toEqual({ island: 'Stall', letter: 's28' });
    expect(splitStallName('HALLMASTER')).toEqual({ island: 'HALLMASTER', letter: null });
  });
});
