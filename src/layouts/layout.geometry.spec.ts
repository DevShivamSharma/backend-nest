import { HallBounds, isInsideHall, stallsOverlap } from './layout.geometry';

const square: HallBounds = { shape: 'SQUARE', width: 40, length: 40, radius: 0 };
const circle: HallBounds = { shape: 'CIRCLE', width: 0, length: 0, radius: 20 };

const stall = (posX: number, posZ: number, width = 5, length = 5) => ({
  posX,
  posZ,
  width,
  length,
});

describe('isInsideHall — rectangular (BR-11)', () => {
  it('accepts a stall at the centre', () => {
    expect(isInsideHall(square, stall(0, 0))).toBe(true);
  });

  it('accepts a stall exactly flush against the wall', () => {
    // 17.5 + 2.5 = 20 = 40 / 2
    expect(isInsideHall(square, stall(17.5, 0))).toBe(true);
    expect(isInsideHall(square, stall(0, -17.5))).toBe(true);
    expect(isInsideHall(square, stall(-17.5, 17.5))).toBe(true);
  });

  it('rejects a stall that crosses the wall by a hair', () => {
    expect(isInsideHall(square, stall(17.51, 0))).toBe(false);
    expect(isInsideHall(square, stall(0, 18))).toBe(false);
  });

  it('checks width against X and length against Z independently', () => {
    const narrowHall: HallBounds = { shape: 'SQUARE', width: 10, length: 40, radius: 0 };

    expect(isInsideHall(narrowHall, stall(0, 15, 5, 5))).toBe(true);
    expect(isInsideHall(narrowHall, stall(0, 0, 12, 5))).toBe(false);
  });

  it('tolerates floating point noise within 1e-8', () => {
    expect(isInsideHall(square, stall(17.5 + 1e-9, 0))).toBe(true);
    expect(isInsideHall(square, stall(17.5 + 1e-6, 0))).toBe(false);
  });
});

describe('isInsideHall — circular (BR-11, conservative half-diagonal rule)', () => {
  const halfDiagonal = Math.hypot(2.5, 2.5); // ~3.5355

  it('accepts a stall at the centre', () => {
    expect(isInsideHall(circle, stall(0, 0))).toBe(true);
  });

  it('accepts a stall whose half-diagonal circle just touches the rim', () => {
    expect(isInsideHall(circle, stall(20 - halfDiagonal, 0))).toBe(true);
  });

  it('rejects just beyond that', () => {
    expect(isInsideHall(circle, stall(20 - halfDiagonal + 0.01, 0))).toBe(false);
  });

  it('is deliberately stricter than a four-corner check', () => {
    // On the X axis at 17: farthest corners are at hypot(19.5, 2.5) = 19.66 < 20, so the
    // rectangle geometrically fits — but 17 + 3.5355 = 20.54 > 20, so the Java rule rejects it.
    expect(Math.hypot(19.5, 2.5)).toBeLessThan(20);
    expect(isInsideHall(circle, stall(17, 0))).toBe(false);
  });

  it('ignores hall width/length for a circle', () => {
    expect(isInsideHall({ ...circle, width: 1, length: 1 }, stall(10, 10))).toBe(true);
  });
});

describe('stallsOverlap (BR-13)', () => {
  it('detects two stalls on the same spot', () => {
    expect(stallsOverlap(stall(0, 0), stall(0, 0))).toBe(true);
  });

  it('detects a partial overlap', () => {
    expect(stallsOverlap(stall(0, 0), stall(4, 0))).toBe(true);
    expect(stallsOverlap(stall(0, 0), stall(4, 4))).toBe(true);
  });

  it('allows stalls that share an edge — shops may stand wall to wall', () => {
    expect(stallsOverlap(stall(0, 0), stall(5, 0))).toBe(false);
    expect(stallsOverlap(stall(0, 0), stall(0, -5))).toBe(false);
  });

  it('allows stalls that touch only at a corner', () => {
    expect(stallsOverlap(stall(0, 0), stall(5, 5))).toBe(false);
  });

  it('requires overlap on BOTH axes', () => {
    expect(stallsOverlap(stall(0, 0), stall(1, 10))).toBe(false);
    expect(stallsOverlap(stall(0, 0), stall(10, 1))).toBe(false);
  });

  it('uses each stall own dimensions', () => {
    // widths 10 and 2 -> threshold 6 on X
    expect(stallsOverlap(stall(0, 0, 10, 5), stall(5.9, 0, 2, 5))).toBe(true);
    expect(stallsOverlap(stall(0, 0, 10, 5), stall(6, 0, 2, 5))).toBe(false);
  });

  it('is symmetric', () => {
    const a = stall(0, 0, 10, 4);
    const b = stall(5, 2, 3, 6);

    expect(stallsOverlap(a, b)).toBe(stallsOverlap(b, a));
  });
});
