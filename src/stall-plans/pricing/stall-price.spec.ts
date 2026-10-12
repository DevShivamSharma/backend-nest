import { PriceCard, PricedStall, PriceRates, stallPrice } from './stall-price';

describe('stallPrice', () => {
  const rates = (more: Partial<PriceRates> = {}): PriceRates => ({
    bareRate: 8000,
    shellRate: 9500,
    side2Percent: 5,
    side3Percent: 10,
    side4Percent: 15,
    catalogueCharge: 5000,
    fnbPrice: null,
    ...more,
  });
  const card: PriceCard = { general: rates(), premium: rates({ shellRate: 12000 }), marquee: null };
  const stall = (more: Partial<PricedStall> = {}): PricedStall => ({
    width: 3,
    depth: 4,
    scheme: 'shell',
    openSides: ['bottom'],
    isPremium: false,
    isMarqueeAvailable: false,
    isFnb: false,
    isBlocked: false,
    isActive: true,
    ...more,
  });

  it('is area × the shell or bare rate, plus the catalogue charge', () => {
    expect(stallPrice(stall(), card, null)).toEqual({
      price: 12 * 9500 + 5000,
      from: 'card',
      type: 'general',
      reckoning: '12 m² × ₹9,500 shell + ₹5,000 catalogue',
    });
    expect(stallPrice(stall({ scheme: 'raw' }), card, null)!.price).toBe(12 * 8000 + 5000);
  });

  it('adds the open-side percentage for 2, 3 and 4 sides', () => {
    const sides = (n: number) =>
      stallPrice(stall({ openSides: ['top', 'right', 'bottom', 'left'].slice(0, n) }), card, null)!;
    expect(sides(2).price).toBe(Math.round(114000 * 1.05) + 5000);
    expect(sides(3).price).toBe(Math.round(114000 * 1.1) + 5000);
    expect(sides(4).reckoning).toBe(
      '12 m² × ₹9,500 shell + 15% for 4 open sides + ₹5,000 catalogue',
    );
  });

  it('goes by Premium rates for a premium stall, and General when the card has none', () => {
    expect(stallPrice(stall({ isPremium: true }), card, null)).toMatchObject({
      price: 12 * 12000 + 5000,
      type: 'premium',
    });
    expect(stallPrice(stall({ isMarqueeAvailable: true }), card, null)!.type).toBe('general');
  });

  it('gives a food & beverage stall its own price when the card has one', () => {
    const fnb = { ...card, general: rates({ fnbPrice: 200000 }) };
    expect(stallPrice(stall({ isFnb: true }), fnb, null)!.price).toBe(205000);
    expect(stallPrice(stall({ isFnb: true }), card, null)!.price).toBe(119000);
  });

  it('takes a price set on the stall first, and prices nothing that is not for sale', () => {
    expect(stallPrice(stall(), card, { price: 99999.6, note: 'Agreed' })).toEqual({
      price: 100000,
      from: 'stall',
      type: null,
      reckoning: 'Set on the stall: Agreed',
    });
    expect(stallPrice(stall({ isBlocked: true }), card, null)).toBeNull();
    expect(stallPrice(stall({ isActive: false }), card, { price: 1, note: null })).toBeNull();
    expect(stallPrice(stall(), null, null)).toBeNull();
  });
});
