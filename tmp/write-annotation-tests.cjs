const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../frontend-angular');
fs.writeFileSync(path.join(root, 'src/app/planner/geometry/annotation-placement.spec.ts'), `import { ANNOTATION_GAP, annotationRect, placeAnnotationCards } from './annotation-placement';
import { Point, rectOverlapsPolygon } from './placement-rules';

describe('annotation card spacing', () => {
  const floor: Point[] = [{ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 100 }, { x: 0, z: 100 }];
  const card = (x: number, z: number, width = 16) => ({ anchor: { x, z }, width, height: 4.2 });

  it('pulls a wide left-side card clear of the wall while keeping its row', () => {
    const [result] = placeAnnotationCards([card(-8, 40, 25)], [floor]);
    expect(result.anchor.z).toBe(40);
    expect(annotationRect(result).maxX).toBeCloseTo(-ANNOTATION_GAP);
  });

  it('clears a separate foyer below the main hall', () => {
    const foyer = [{ x: 20, z: 110 }, { x: 60, z: 110 }, { x: 60, z: 125 }, { x: 20, z: 125 }];
    const [result] = placeAnnotationCards([card(8, 116, 30)], [floor, foyer]);
    expect(result.anchor.z).toBe(116);
    expect(rectOverlapsPolygon(annotationRect(result, ANNOTATION_GAP), foyer)).toBe(false);
  });

  it('reserves space for gate text and neighbouring cards', () => {
    const label = { minX: -4, maxX: -1, minZ: 40, maxZ: 41 };
    const cards = [card(-8, 40), card(-8, 43), card(-8, 46)];
    const placed = placeAnnotationCards(cards, [floor], [label]);
    const overlaps = (a: ReturnType<typeof annotationRect>, b: ReturnType<typeof annotationRect>) =>
      a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6 &&
      a.minZ < b.maxZ - 1e-6 && a.maxZ > b.minZ + 1e-6;
    placed.forEach((item, i) => {
      const padded = annotationRect(item, ANNOTATION_GAP);
      expect(rectOverlapsPolygon(padded, floor)).toBe(false);
      expect(overlaps(padded, label)).toBe(false);
      placed.forEach((other, j) => {
        if (i !== j) expect(overlaps(padded, annotationRect(other))).toBe(false);
      });
    });
  });

  it('keeps clear cards and intentional interior annotations in place', () => {
    const cards = [card(-30, 20), card(25, 50)];
    expect(placeAnnotationCards(cards, [floor])).toEqual(cards);
  });

  it('does not move the source facility anchor or mutate saved data', () => {
    const input = Object.freeze({ ...card(-8, 40), anchor: Object.freeze({ x: -8, z: 40 }) });
    const [result] = placeAnnotationCards(Object.freeze([input]), [floor]);
    expect(result.anchor).not.toEqual(input.anchor);
    expect(input.anchor).toEqual({ x: -8, z: 40 });
  });

  it('follows stepped and concave walls instead of the hall bounding box', () => {
    const stepped = [
      { x: 20, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 100 },
      { x: 0, z: 100 }, { x: 0, z: 50 }, { x: 20, z: 50 },
    ];
    const [result] = placeAnnotationCards([card(10, 20)], [stepped]);
    expect(result.anchor.z).toBe(20);
    expect(annotationRect(result).maxX).toBeCloseTo(19);
  });
});
`);
