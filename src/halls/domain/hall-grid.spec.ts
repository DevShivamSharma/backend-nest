import { blockedAreas, gridSize, outlineError, type Corner } from './hall-grid';

const L: Corner[] = [
  [0, 0],
  [6, 0],
  [6, 3],
  [10, 3],
  [10, 8],
  [0, 8],
];

describe('gridSize', () => {
  it('holds a fractional side in whole cells', () => {
    expect(gridSize(10, 8)).toEqual({ columns: 10, rows: 8 });
    expect(gridSize(10.5, 7.2)).toEqual({ columns: 11, rows: 8 });
  });
});

describe('blockedAreas', () => {
  it('blocks nothing for a whole-metre rectangle, drawn or not', () => {
    expect(blockedAreas(10, 8)).toEqual([]);
    expect(
      blockedAreas(10, 8, [
        [0, 0],
        [10, 0],
        [10, 8],
        [0, 8],
      ]),
    ).toEqual([]);
  });

  it('blocks the strip beyond a fractional side', () => {
    const areas = blockedAreas(10.5, 7.5);

    // Column 10 (centre 10.5) and row 7 (centre 7.5) lie outside the 10.5 x 7.5 hall.
    expect(areas.reduce((sum, a) => sum + a.width * a.height, 0)).toBe(11 * 8 - 10 * 7);
  });

  it('blocks the cut corner of an L shape as one rectangle', () => {
    expect(blockedAreas(10, 8, L)).toEqual([
      { x: 6, y: 0, width: 4, height: 3, fillColor: '#ffffff', strokeColor: '#ffffff' },
    ]);
  });

  it('covers exactly the cells whose centre is outside a triangle', () => {
    const triangle: Corner[] = [
      [0, 0],
      [6, 0],
      [0, 6],
    ];
    const blocked = blockedAreas(6, 6, triangle).reduce((sum, a) => sum + a.width * a.height, 0);

    // Centres inside the triangle: x + y < 6 with x, y = i + 0.5, i.e. 15 of the 36 cells.
    expect(blocked).toBe(36 - 15);
  });

  it('keeps a hole in the middle of a U shape', () => {
    const u: Corner[] = [
      [0, 0],
      [3, 0],
      [3, 4],
      [6, 4],
      [6, 0],
      [9, 0],
      [9, 8],
      [0, 8],
    ];
    const areas = blockedAreas(9, 8, u);

    expect(areas).toEqual([
      { x: 3, y: 0, width: 3, height: 4, fillColor: '#ffffff', strokeColor: '#ffffff' },
    ]);
  });

  it('copes with a 2000 x 2000 m hall quickly', () => {
    const started = Date.now();
    const circle: Corner[] = Array.from({ length: 200 }, (_, i) => [
      1000 + 1000 * Math.cos((i / 200) * 2 * Math.PI),
      1000 + 1000 * Math.sin((i / 200) * 2 * Math.PI),
    ]);
    const areas = blockedAreas(2000, 2000, circle);

    expect(areas.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('outlineError', () => {
  it('accepts a rectangle and an L', () => {
    expect(
      outlineError(
        [
          [0, 0],
          [10, 0],
          [10, 8],
          [0, 8],
        ],
        10,
        8,
      ),
    ).toBeNull();
    expect(outlineError(L, 10, 8)).toBeNull();
  });

  it('refuses points outside the hall', () => {
    expect(
      outlineError(
        [
          [0, 0],
          [10, 0],
          [10, 8],
          [-1, 8],
        ],
        10,
        8,
      ),
    ).toMatch(/inside/);
    expect(
      outlineError(
        [
          [0, 0],
          [12, 0],
          [12, 8],
          [0, 8],
        ],
        10,
        8,
      ),
    ).toMatch(/inside/);
  });

  it('refuses an outline that crosses itself', () => {
    expect(
      outlineError(
        [
          [0, 0],
          [10, 8],
          [10, 0],
          [0, 8],
        ],
        10,
        8,
      ),
    ).toMatch(/cross/);
  });

  it('refuses an outline that leaves no floor', () => {
    expect(
      outlineError(
        [
          [0, 0],
          [10, 0],
          [10, 0.2],
        ],
        10,
        8,
      ),
    ).toMatch(/no usable/);
  });
});
