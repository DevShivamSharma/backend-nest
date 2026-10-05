import { validateHallGeometry } from '../layouts/placement/hall-geometry';
import { type CadDrawing, type CadText } from './cad-drawing';
import { analyseDrawing } from './hall-analysis';
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
