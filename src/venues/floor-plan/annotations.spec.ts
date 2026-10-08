import { detectAnnotations, layoutAnnotations } from './annotations';
import { area, intersection, rectangle, union } from './geometry';
import { exportConfig, reviewHall } from './review';
import { swatchColor } from './cad/hall-analysis';
import type { PlanPage, TextBox } from './plan.types';

const text = (value: string, x: number, y: number, confidence = 1): TextBox => ({
  text: value,
  x,
  y,
  width: 8,
  height: 2,
  source: confidence < 1 ? 'ocr' : 'vector',
  confidence,
});
function page(): PlanPage {
  return {
    number: 1,
    width: 220,
    height: 150,
    format: 'pdf-vector',
    preview: '',
    texts: [
      text('TOILET (MALE)', 8, -4),
      text('TOILET (FEMALE)', 12, -4),
      text('STAIRS', 15, -4),
      text('DRINKING WATER', 38, 38),
      text('S1001', 22, -2),
      text('E1001', 20, 40),
      text('LEGEND:', 170, 4),
      text('EMERGENCY EXIT', 170, 10),
      text('ENTRY FROM HALL 99', 5, -8),
      text('E2020', 10, 20),
      text('EMERGENCY EXIT', 0, 20, 0.6),
      text('120.45', 10, 10),
    ],
    regions: [
      {
        id: 'a',
        name: 'North hall',
        role: 'hall',
        geometry: rectangle(0, 0, 40, 40),
        hallIds: [],
        confirmed: true,
        restrictionsConfirmed: true,
        grid: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        printedArea: 1600,
      },
      {
        id: 'f',
        name: 'Entry foyer',
        role: 'foyer',
        geometry: rectangle(12, 40, 16, 8),
        hallIds: ['a'],
        confirmed: true,
        grid: null,
        printedArea: null,
      },
      {
        id: 'b',
        name: 'South hall',
        role: 'hall',
        geometry: rectangle(90, 0, 40, 40),
        hallIds: [],
        confirmed: true,
        grid: { x: 90, y: 0, width: 1, height: 1, rotation: 0 },
        printedArea: 1600,
      },
    ],
    objects: [],
    calibration: { metresPerUnit: 1, source: 'Metres', confirmed: true },
    grid: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    dimensions: [],
    legend: [{ label: 'Columns', color: '#777777' }],
    warnings: [],
  };
}
describe('Source helpers and exterior annotation layout', () => {
  it('preserves a grey column legend swatch without mistaking black annotation text for its colour', () => {
    const row = { layer: '', text: 'Columns', x: 40, y: 40, height: 2 };
    const source = {
      texts: [row],
      polylines: [],
      fills: [
        { layer: '', color: '#808080', loops: [[31, 39, 33, 39, 33, 41, 31, 41]] },
        { layer: '', color: '#000000', loops: [[32, 39, 35, 39, 35, 41, 32, 41]] },
      ],
    };
    expect(swatchColor(source, row, null)).toBe('#808080');
    expect(swatchColor(source, { ...row, text: 'Emergency exit' }, null)).toBeNull();
  });
  it('recognises facilities and edge gate codes while excluding legends, directions, dimensions and interior stall codes', () => {
    const p = page();
    const found = detectAnnotations(p);
    expect(found.filter((a) => a.confirmed).map((a) => a.kind ?? a.text)).toEqual(
      expect.arrayContaining([
        'toilet-male',
        'toilet-female',
        'stairs',
        'drinking-water',
        'S1001',
        'E1001',
      ]),
    );
    expect(found.some((a) => a.text === 'E2020' || a.text === '120.45' || a.text === 'Entry')).toBe(
      false,
    );
    expect(found.filter((a) => a.kind === 'emergency-exit')).toHaveLength(1);
    expect(found.find((a) => a.kind === 'emergency-exit')?.confirmed).toBe(false);
  });
  it('groups nearby icons into cards and keeps every complete card/label outside all attached grid areas without overlap', () => {
    const p = page();
    p.annotations = detectAnnotations(p);
    const boundary = union(p.regions[0].geometry, p.regions[1].geometry);
    const before = JSON.stringify(boundary);
    const layout = layoutAnnotations(p, 'a', boundary, 1, [0, 0]);
    expect(layout.iconGroups.some((g) => g.icons.length === 3)).toBe(true);
    expect(layout.labels.map((l) => l.text)).toEqual(
      expect.arrayContaining(['North hall', 'Entry foyer', 'S1001']),
    );
    const boxes = [...layout.labels, ...layout.iconGroups].map((a) =>
      rectangle(a.x, a.y, a.width!, a.height!),
    );
    for (let i = 0; i < boxes.length; i++) {
      expect(area(intersection(boxes[i], boundary))).toBeLessThan(1e-7);
      for (let j = i + 1; j < boxes.length; j++)
        expect(area(intersection(boxes[i], boxes[j]))).toBeLessThan(1e-7);
    }
    expect(JSON.stringify(boundary)).toBe(before);
  });
  it('keeps annotations hall-scoped and exports positioned helper_text while leaving drawable geometry unchanged', () => {
    const p = page();
    p.annotations = detectAnnotations(p);
    const floor = reviewHall('source', 1, p, p.regions[0]).floor!;
    const other = reviewHall('source', 1, p, p.regions[2]).floor!;
    expect(other.iconGroups).toEqual([]);
    expect(floor.iconGroups.length).toBeGreaterThan(0);
    expect(area(floor.geometry!.boundary)).toBe(1728);
    const config = exportConfig('North hall', floor).data[0];
    expect(config.helper_text[0].image.map((i) => i.url)).toEqual(
      expect.arrayContaining(['assets/images/toilet-male.svg', 'assets/images/toilet-female.svg']),
    );
    expect(config.helper_text[0].positionX).toBe(floor.iconGroups[0].x * 20);
    expect(config.exit_labels.some((l) => l.text === 'Entry foyer')).toBe(true);
  });
});
