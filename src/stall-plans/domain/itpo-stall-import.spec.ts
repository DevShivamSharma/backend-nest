import { itpoStall } from './itpo-stall-push';
import { stallFromItpo, type ItpoStallRow } from './itpo-stall-import';
import type { PublishedStall } from './plan.model';

const stall: PublishedStall = {
  eventHallId: 'h',
  stallId: '11111111-1111-4111-8111-111111111111',
  publishedRevision: 1,
  zoneId: null,
  islandNumber: '12A-',
  stallNumber: '27 E',
  x: 10,
  y: 4,
  width: 4,
  depth: 3,
  openSides: ['top', 'right'],
  cutCells: [[3, 2]],
  labelArea: null,
  scheme: 'raw',
  categoryIds: ['7'],
  isPremium: true,
  isBlocked: false,
  isFnb: false,
  isBranding: false,
  isHorseshoe: false,
  isMarqueeAvailable: true,
  isRestrictedForOverseas: false,
  isActive: true,
  location: null,
  description: null,
  price: 1500000,
  pricePaise: null,
  currency: null,
  priceReckoning: null,
};

describe('stallFromItpo', () => {
  it('should give back the stall that itpoStall() wrote', () => {
    const written = itpoStall(stall, new Map([['7', 7]]), 'H');
    const row: ItpoStallRow = {
      id: stall.stallId,
      island_number: written.island_number,
      stall_number: written.stall_number,
      description: null,
      location: null,
      stall_coordinates: written.stall_coordinates,
      layout_grid: written.layout_grid,
      category_id: written.category_id,
      is_premium: written.is_premium,
      is_blocked: false,
      is_fnb_stall: false,
      is_branding_stall: false,
      is_horseshoe_stall: false,
      is_marquee_available: true,
      is_restricted_for_overseas: false,
      price: written.price,
    };
    expect(stallFromItpo(row)).toMatchObject({
      id: stall.stallId,
      x: 10,
      y: 4,
      width: 4,
      depth: 3,
      cutCells: [[3, 2]],
      categoryIds: ['7'],
      isPremium: true,
      isMarqueeAvailable: true,
      price: 1500000,
    });
    expect([...stallFromItpo(row)!.openSides].sort()).toEqual(['right', 'top']);
  });

  it('should skip a row with no position', () => {
    expect(stallFromItpo({ id: 'x', stall_coordinates: null } as ItpoStallRow)).toBeNull();
  });
});
