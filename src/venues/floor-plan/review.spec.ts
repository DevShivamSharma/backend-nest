import { analysePage } from './analyse';
import { area, difference, geometryProblems, rectangle, transform } from './geometry';
import { drawable, exportConfig, floorDiff, reviewHall } from './review';
import type { PlanPage } from './plan.types';
import type { SourcePage } from './source';
export function fixture(): PlanPage {
  return {
    number: 1,
    width: 100,
    height: 100,
    format: 'pdf-vector',
    preview: '',
    texts: [],
    regions: [
      {
        id: 'a',
        name: 'North hall',
        role: 'hall',
        geometry: rectangle(10, 10, 20, 30),
        hallIds: [],
        confirmed: true,
        restrictionsConfirmed: true,
        grid: { x: 10, y: 10, width: 2, height: 2, rotation: 0 },
        printedArea: 600,
      },
      {
        id: 'b',
        name: 'South hall',
        role: 'hall',
        geometry: rectangle(40, 10, 20, 30),
        hallIds: [],
        confirmed: true,
        restrictionsConfirmed: true,
        grid: { x: 40, y: 10, width: 2, height: 2, rotation: 0 },
        printedArea: 600,
      },
      {
        id: 'foyer',
        name: 'Shared foyer',
        role: 'foyer',
        geometry: rectangle(30, 10, 10, 30),
        hallIds: ['a', 'b'],
        confirmed: true,
        grid: null,
        printedArea: null,
      },
    ],
    objects: [],
    calibration: { metresPerUnit: 1, source: 'Measured 20 m', confirmed: true },
    grid: null,
    dimensions: [
      {
        id: 'width',
        label: 'North width',
        a: [10, 10],
        b: [30, 10],
        metres: 20,
        regionId: 'a',
        confirmed: true,
      },
      {
        id: 'width-b',
        label: 'South width',
        a: [40, 10],
        b: [60, 10],
        metres: 20,
        regionId: 'b',
        confirmed: true,
      },
    ],
    legend: [],
    warnings: [],
  };
}
describe('Reviewed metric floor geometry', () => {
  it('includes a shared foyer without folding it into hall area, and retains common identity', () => {
    const p = fixture(),
      a = reviewHall('doc', 1, p, p.regions[0]),
      b = reviewHall('doc', 1, p, p.regions[1]);
    expect(a.review.ready).toBe(true);
    expect(a.review).toMatchObject({
      hallArea: 600,
      foyerArea: 300,
      drawableArea: 900,
      width: 30,
      depth: 30,
    });
    expect(a.floor!.geometry!.zones[0].id).toEqual(b.floor!.geometry!.zones[0].id);
    expect(a.floor!.geometry!.source.origin).toEqual([10, 10]);
    expect(b.floor!.geometry!.source.origin).toEqual([30, 10]);
  });
  it('blocks an unknown scale regardless of acknowledgements', () => {
    const p = fixture();
    p.calibration.confirmed = false;
    const initial = reviewHall('doc', 1, p, p.regions[0]);
    expect(
      reviewHall(
        'doc',
        1,
        p,
        p.regions[0],
        initial.review.checks.map((c) => c.id),
      ).review.ready,
    ).toBe(false);
  });
  it('does not let uncertain classifications become drawable restrictions', () => {
    const p = fixture();
    p.objects.push({
      id: 'x',
      kind: 'unknown',
      label: 'Area',
      geometry: rectangle(12, 12, 4, 4),
      color: '#ff0000',
      confirmed: false,
      evidence: { source: 'geometry', detail: 'Uncertain' },
    });
    const r = reviewHall('doc', 1, p, p.regions[0]);
    expect(r.review.ready).toBe(false);
    expect(r.floor!.geometry!.objects).toHaveLength(0);
  });
  it('keeps holes exact and rejects crossing boundaries', () => {
    const g = difference(rectangle(0, 0, 10, 10), rectangle(3, 3, 2, 2));
    expect(area(g)).toBe(96);
    expect(geometryProblems(g)).toEqual([]);
    expect(
      geometryProblems([
        [
          [
            [0, 0],
            [10, 10],
            [0, 10],
            [10, 0],
            [0, 0],
          ],
        ],
      ]),
    ).not.toEqual([]);
  });
  it('reports a failed dimension without hiding behind matching area', () => {
    const p = fixture();
    p.dimensions[0].metres = 21;
    const r = reviewHall('doc', 1, p, p.regions[0]);
    expect(r.review.ready).toBe(false);
    expect(r.review.checks.find((c) => c.id.endsWith('dim-width'))?.status).toBe('fail');
    expect(reviewHall('doc', 1, p, p.regions[0], ['1:a:dim-width']).review.ready).toBe(true);
  });
  it('checks printed grid notes independently after editing pitch', () => {
    const p = fixture();
    p.texts = [
      {
        text: 'NOTE Grid size 1m x 1m',
        x: 0,
        y: 0,
        width: 10,
        height: 2,
        source: 'vector',
        confidence: 1,
      },
    ];
    expect(
      reviewHall('doc', 1, p, p.regions[0]).review.checks.find((c) => c.id.endsWith('grid-note'))
        ?.status,
    ).toBe('fail');
  });
  it('keeps exact off-grid bands without blocking a second full grid row', () => {
    const p = fixture();
    p.objects.push({
      id: 'fire',
      kind: 'fire_curtain',
      label: 'Fire curtain',
      geometry: rectangle(10, 14.5, 20, 1),
      color: '#cc22ee',
      confirmed: true,
      evidence: { source: 'legend', detail: 'Printed legend' },
    });
    const f = reviewHall('doc', 1, p, p.regions[0]).floor!;
    expect(area(drawable(f))).toBe(880);
    expect(f.geometry!.objects[0].geometry[0][0][0]).toEqual([0, 4.5]);
  });
  it('computes geometric differences and catches a lost area above the 99% regression threshold', () => {
    const p = fixture(),
      a = reviewHall('doc', 1, p, p.regions[0]).floor!;
    p.regions[0].geometry = rectangle(10, 10, 19, 30);
    const b = reviewHall('doc', 1, p, p.regions[0]).floor!;
    const d = floorDiff(a, b);
    expect(d.removedArea).toBe(30);
    expect(d.addedArea).toBe(0);
    expect(d.iou).toBeLessThan(0.99);
  });
  it('exports exact legacy rectangles for orthogonal shapes and labels geometry-only curves', () => {
    const p = fixture();
    p.objects.push({
      id: 'fire',
      kind: 'fire_curtain',
      label: 'Fire curtain',
      geometry: rectangle(10, 14.5, 20, 1),
      color: '#cc22ee',
      confirmed: true,
      evidence: { source: 'legend', detail: 'Printed legend' },
    });
    const floor = reviewHall('doc', 1, p, p.regions[0]).floor!,
      config = exportConfig('North', floor);
    expect(config.requiresGeometryRenderer).toBe(false);
    expect(config.data[0].layout_data.nonClickableAreas).toContainEqual(
      expect.objectContaining({ kind: 'fire_curtain', fillColor: '#cc22ee', height: 1, y: 4.5 }),
    );
    floor.geometry!.boundary = [
      [
        [
          [0, 0],
          [20, 0],
          [15, 30],
          [0, 0],
        ],
      ],
    ];
    expect(exportConfig('Triangle', floor).requiresGeometryRenderer).toBe(true);
  });
  it('detects generic separated grids, preserving non-one-metre pitch and rotation', () => {
    const angle = (7 * Math.PI) / 180;
    const rot = (p: [number, number]): [number, number] => [
      p[0] * Math.cos(angle) - p[1] * Math.sin(angle) + 150,
      p[0] * Math.sin(angle) + p[1] * Math.cos(angle) + 100,
    ];
    const source: SourcePage = {
      number: 1,
      width: 1000,
      height: 800,
      preview: '',
      texts: [],
      lines: [],
      fills: [],
      format: 'dxf',
      unitMetres: 0.1,
      warnings: [],
    };
    for (const x of [0, 300]) {
      for (let i = 0; i <= 10; i++) {
        source.lines.push({
          a: rot([x + i * 20, 0]),
          b: rot([x + i * 20, 300]),
          color: '#777777',
          width: 0.1,
          dashed: false,
        });
      }
      for (let i = 0; i <= 15; i++)
        source.lines.push({
          a: rot([x, i * 20]),
          b: rot([x + 200, i * 20]),
          color: '#777777',
          width: 0.1,
          dashed: false,
        });
    }
    const p = analysePage(source),
      h = p.regions.filter((r) => r.role === 'hall');
    expect(h).toHaveLength(2);
    expect(h[0].grid!.rotation).toBeCloseTo(7);
    expect(h[0].grid!.width * 0.1).toBeCloseTo(2);
    const truth = transform(rectangle(0, 0, 200, 300), rot);
    expect(area(difference(truth, h[0].geometry)) / area(truth)).toBeLessThan(0.01);
  });
});
