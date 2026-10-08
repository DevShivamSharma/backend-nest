import { gridScale } from './pdf-drawing';
import type { PageVectors, VectorPath } from './pdf-vectors';

function drawing(note: string, yPitch = 10): PageVectors {
  const paths: VectorPath[] = [];
  // Independent hall/foyer phases and a misleading, differently sized legend grid.
  for (const [ox, oy, layer] of [
    [0, 0, 'GRID'],
    [300.7, 250.3, 'GRID'],
    [600, 600, 'LEGEND'],
  ] as const) {
    const pitch = layer === 'LEGEND' ? 3 : 10;
    for (let i = 0; i <= 20; i++) {
      paths.push({
        layer,
        stroke: '#777777',
        fill: null,
        width: 1,
        segments: [
          { x1: ox + i * pitch, y1: oy, x2: ox + i * pitch, y2: oy + 20 * yPitch },
          { x1: ox, y1: oy + i * yPitch, x2: ox + 20 * pitch, y2: oy + i * yPitch },
        ],
      });
    }
  }
  return {
    width: 1000,
    height: 1000,
    rotation: 0,
    pageCount: 1,
    layers: ['GRID', 'LEGEND'],
    paths,
    texts: [{ text: note, x: 900, y: 900, size: 10, vertical: false }],
  };
}

describe('Printed CAD grid calibration', () => {
  it('calibrates a non-one-metre grid without rounding its physical cell size', () => {
    const scale = gridScale(drawing('NOTE: Grid size is 230cm x 230cm'));
    expect(scale?.cell.width).toBeCloseTo(2.3, 8);
    expect(scale?.cell.height).toBeCloseTo(2.3, 8);
    expect(scale?.metresPerUnit).toBeCloseTo(0.23, 3);
  });
  it('does not infer metres from grid density when the source has no grid-size note', () => {
    expect(gridScale(drawing('HALL ALPHA'))).toBeNull();
  });
  it('rejects conflicting X and Y scale evidence', () => {
    expect(gridScale(drawing('Grid size is 1m x 1m', 14))).toBeNull();
  });
});
