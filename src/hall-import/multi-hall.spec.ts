import { validateHallGeometry } from '../layouts/placement/hall-geometry';
import { type CadDrawing, type CadText } from './cad-drawing';
import { analyseDrawing, hallGridAreas } from './hall-analysis';
import { joinHallTitleFragments } from './pdf-drawing';

const text = (value: string, x: number, y: number, height = 2): CadText =>
  ({ text: value, x, y, height, layer: 'TEXT' });

/** Two grid-covered halls connected through a 15 m open foyer; no closed passage band. */
function connectedPlan(): CadDrawing {
  const drawing: CadDrawing = {
    format: 'pdf', metresPerUnit: 1, scaleSource: 'Test metres', warnings: [],
    layers: ['HALL-BOUNDARY', 'GRID', 'NC'], inserts: [],
    fills: [{ layer: 'NC', color: '#ff0000', loops: [[3, 5, 5, 5, 5, 100, 3, 100]] }],
    texts: [text('HALL 12A', 20, -6), text('HALL 12', 75, -6), text('FOYER', 47, 20),
      text('ENTRY FROM HALL 11', 110, 20), text('LEGEND ......', 140, 115),
      text('NO CONSTRUCTION ZONE', 150, 110), text('OTHER SYMBOLS', 150, 106),
      text('LEGEND :', 140, -20), text('H - Hall', 150, -25), text('T - Toilet', 150, -29)],
    polylines: [
      { layer: 'HALL-BOUNDARY', color: '#000000', closed: true,
        points: [0, 0, 95, 0, 95, 40, 40, 40, 40, 110, 0, 110] },
      { layer: 'LEGEND', color: '#ff0000', closed: true, points: [133, 109, 135, 109, 135, 111, 133, 111] },
      // A no-construction strip in the left hall, not a closed hall boundary.
      { layer: 'NC', color: '#ff0000', closed: true, points: [3, 5, 5, 5, 5, 100, 3, 100] },
    ],
  };
  for (const [x, y, width, height] of [[1, 1, 38, 108], [56, 1, 38, 38]]) {
    for (let dx = 0; dx <= width; dx += 2) drawing.polylines.push({
      layer: 'GRID', color: '#989898', closed: false, points: [x + dx, y, x + dx, y + height],
    });
    for (let dy = 0; dy <= height; dy += 2) drawing.polylines.push({
      layer: 'GRID', color: '#989898', closed: false, points: [x, y + dy, x + width, y + dy],
    });
  }
  return drawing;
}

describe('PDF hall titles', () => {
  it('joins adjacent, aligned hall-number runs without changing the input', () => {
    const input = [text('HALL', 100, 20, 10), text('12', 128, 20, 10), text('HALL 12A', 30, 20, 10)];
    const joined = joinHallTitleFragments(input);
    expect(joined.map((t) => t.text)).toEqual(['HALL 12', 'HALL 12A']);
    expect(joined[0].x).toBeGreaterThan(100);
    expect(joined[0].x).toBeLessThan(128);
    expect(input[0].text).toBe('HALL');
  });

  it('does not attach distant, differently sized or different-line numbers', () => {
    const input = [text('HALL', 100, 20, 10), text('12', 180, 20, 10),
      text('13', 128, 25, 10), text('14', 128, 20, 4)];
    expect(joinHallTitleFragments(input)).toEqual(input);
  });
});

describe('halls connected through an open foyer', () => {
  it('returns separately named, non-overlapping floors and keeps the foyer out of both', () => {
    const result = analyseDrawing(connectedPlan(), 'any-name.pdf');
    expect(result.multiHall).toBe(true);
    expect(result.candidates.map((h) => h.name)).toEqual(['Hall 12', 'Hall 12A']);
    const [right, left] = result.candidates;
    expect(left.areaM2).toBeGreaterThan(right.areaM2 * 2.5);
    const maxLeft = Math.max(...left.boundary.map((p) => p.x + left.origin.x));
    const minRight = Math.min(...right.boundary.map((p) => p.x + right.origin.x));
    expect(minRight - maxLeft).toBeGreaterThan(14);
    for (const hall of result.candidates) expect(() => validateHallGeometry({
      ...hall, compass: hall.compass ? { ...hall.compass } : null,
    })).not.toThrow();
    expect(result.overview.markers.some((m) => /foyer/i.test(m.text))).toBe(true);
  });

  it('reads a dotted legend heading and the NC no-construction layer', () => {
    const result = analyseDrawing(connectedPlan(), 'plan.pdf');
    expect(result.candidates[0].legends).toContainEqual(expect.objectContaining({ label: 'NO CONSTRUCTION ZONE', colorCode: '#ff0000' }));
    expect(result.candidates.find((h) => h.name === 'Hall 12A')!.zones.some((z) => z.kind === 'NO_CONSTRUCTION')).toBe(true);
  });

  it('does not split two grid islands belonging to the same hall', () => {
    const drawing = connectedPlan();
    drawing.texts = drawing.texts.filter((t) => t.text !== 'HALL 12');
    drawing.texts.push(text('HALL 12A', 75, -6));
    expect(analyseDrawing(drawing, 'plan.pdf').multiHall).toBe(false);
  });

  it('does not use an area-table row or a direction as the second hall title', () => {
    const drawing = connectedPlan();
    drawing.texts = drawing.texts.filter((t) => t.text !== 'HALL 12');
    drawing.texts.push(text('HALL 12 = 1681 SQ.M.', 75, -6), text('ENTRY FROM HALL 12', 75, 20));
    expect(analyseDrawing(drawing, 'plan.pdf').multiHall).toBe(false);
  });

  it('requires a dense grid in both directions, not just structural axes', () => {
    const drawing = connectedPlan();
    drawing.polylines = drawing.polylines.filter((p) => p.layer !== 'GRID' || p.points[0] < 50 || p.points[0] > 90 || p.points[1] < 5);
    expect(analyseDrawing(drawing, 'plan.pdf').multiHall).toBe(false);
  });
});

describe('grid floors of a multi-hall plan', () => {
  // 1 unit = 1 m. Two halls share one 100 x 50 m grid, divided by a partition at x = 50 (Halls 3
  // and 4); a third hall has its own grid; each of the first two has a foyer grid below it.
  const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const outline = (ring: number[]) => {
    const xs = ring.filter((_, i) => i % 2 === 0);
    const ys = ring.filter((_, i) => i % 2 === 1);
    return { ring, box: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, area: 0, label: '' };
  };
  const grid = {
    rings: [rect(0, 0, 100, 50), rect(110, 0, 150, 50), rect(10, -20, 30, -5), rect(70, -20, 90, -5)],
    snapX: (x: number) => Math.round(x),
    snapY: (y: number) => Math.round(y),
  };
  const floors = [rect(1, 1, 49, 49), rect(51, 1, 99, 49), rect(111, 1, 149, 49)].map(outline);
  const owners = [rect(-5, -25, 50, 55), rect(50, -25, 105, 55), rect(105, -25, 155, 55)].map(outline);
  const areas = hallGridAreas(grid, floors, owners, 1);
  const boxes = (i: number) => areas[i].map((r) => outline(r).box);

  it('cuts a grid two halls share on the grid line between their floors', () => {
    expect(boxes(0)).toContainEqual({ minX: 0, minY: 0, maxX: 50, maxY: 50 });
    expect(boxes(1)).toContainEqual({ minX: 50, minY: 0, maxX: 100, maxY: 50 });
  });

  it('gives each foyer grid to the hall whose part of the building holds it', () => {
    expect(boxes(0)).toContainEqual({ minX: 10, minY: -20, maxX: 30, maxY: -5 });
    expect(boxes(1)).toContainEqual({ minX: 70, minY: -20, maxX: 90, maxY: -5 });
    expect(areas[2]).toHaveLength(1);
    expect(areas.flat()).toHaveLength(5);
  });
});
