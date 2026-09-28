const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../frontend-angular');
const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
write('src/app/planner/geometry/annotation-placement.ts', `import { Point, Rect, pointInPolygon, rectOverlapsPolygon } from './placement-rules';

/** Visual clearance in plan metres, independent of stall placement rules. */
export const ANNOTATION_GAP = 1;

export interface AnnotationCard {
  anchor: Point;
  width: number;
  height: number;
}

export function annotationRect(card: AnnotationCard, gap = 0): Rect {
  return {
    minX: card.anchor.x - gap,
    maxX: card.anchor.x + card.width + gap,
    minZ: card.anchor.z - gap,
    maxZ: card.anchor.z + card.height + gap,
  };
}

/**
 * Clear perimeter cards from the floor, gate labels and neighbouring cards. Source anchors are
 * never edited: only their display positions move. Cards deliberately anchored inside the hall
 * (for example circulation arrows) keep their relationship to the interior.
 *
 * Try the nearest horizontal/vertical shift past obstacle edges. This keeps a perimeter row
 * aligned with its gate instead of packing unrelated facilities together in a separate legend.
 */
export function placeAnnotationCards<T extends AnnotationCard>(
  cards: readonly T[],
  floors: Point[][],
  reserved: readonly Rect[] = [],
): T[] {
  const originals = cards.map((card) => annotationRect(card));
  const placed: Rect[] = [];
  return cards.map((card, index) => {
    const obstacles = [...reserved, ...placed, ...originals.slice(index + 1)];
    const perimeter = !floors.some((floor) => pointInPolygon(card.anchor, floor));
    const relevantFloors = perimeter ? floors : [];
    const clear = (anchor: Point): boolean => {
      const rect = annotationRect({ ...card, anchor }, ANNOTATION_GAP);
      return (
        !obstacles.some((obstacle) => rectanglesOverlap(rect, obstacle)) &&
        !relevantFloors.some((floor) => rectOverlapsPolygon(rect, floor))
      );
    };

    let anchor = { ...card.anchor };
    if (!clear(anchor)) {
      const xs = new Set<number>();
      const zs = new Set<number>();
      for (const floor of relevantFloors) {
        for (const point of floor) {
          xs.add(point.x);
          zs.add(point.z);
        }
      }
      for (const obstacle of obstacles) {
        xs.add(obstacle.minX).add(obstacle.maxX);
        zs.add(obstacle.minZ).add(obstacle.maxZ);
      }
      const candidates: Point[] = [];
      for (const x of xs) {
        candidates.push(
          { x: x - ANNOTATION_GAP - card.width, z: anchor.z },
          { x: x + ANNOTATION_GAP, z: anchor.z },
        );
      }
      for (const z of zs) {
        candidates.push(
          { x: anchor.x, z: z - ANNOTATION_GAP - card.height },
          { x: anchor.x, z: z + ANNOTATION_GAP },
        );
      }
      const distance = (p: Point): number => (p.x - anchor.x) ** 2 + (p.z - anchor.z) ** 2;
      candidates.sort((a, b) => distance(a) - distance(b));
      anchor = candidates.find(clear) ?? anchor;
    }
    const result = { ...card, anchor };
    placed.push(annotationRect(result));
    return result;
  });
}

function rectanglesOverlap(a: Rect, b: Rect): boolean {
  const epsilon = 1e-6;
  return a.minX < b.maxX - epsilon && a.maxX > b.minX + epsilon &&
    a.minZ < b.maxZ - epsilon && a.maxZ > b.minZ + epsilon;
}
`);
const rendererPath = 'src/app/planner/three/annotations-renderer.ts';
let text = fs.readFileSync(path.join(root, rendererPath), 'utf8').replace(/\r\n/g, '\n');
function replace(before, after) {
  if (!text.includes(before)) throw new Error('Missing renderer anchor: ' + before.slice(0, 100));
  text = text.replace(before, after);
}
replace('  cardLayout,\n  PlanCard,', '  cardLayout,\n  CardLayout,\n  PlanCard,');
replace("import { Point, Rect } from '../geometry/placement-rules';", "import { Rect } from '../geometry/placement-rules';\nimport { annotationRect, placeAnnotationCards } from '../geometry/annotation-placement';\nimport { floorOutlines, planSize } from '../geometry/hall-plan';");
replace('import { HallAmenity, HallCompass, HallMarker }', 'import { Hall, HallAmenity, HallCompass, HallMarker }');
replace(' * white card whose top-left corner is the card\'s anchor.', ' * white card, shifted only when its source position would overlap the floor or another label.');
replace('export function buildAmenityCards(amenities: readonly HallAmenity[]): THREE.Group {', 'export function buildAmenityCards(hall: Hall): THREE.Group {');
replace('  for (const card of planCards(amenities)) group.add(buildCard(card));', '  for (const card of layoutAnnotations(hall).cards) group.add(buildCard(card));');
const start = text.indexOf('type Card = PlanCard<HallAmenity>;');
const end = text.indexOf("  const canvas = document.createElement('canvas');", start);
if (start < 0 || end < 0) throw new Error('Missing card block');
text = text.slice(0, start) + `interface DisplayCard extends PlanCard<HallAmenity> {
  layout: CardLayout;
  width: number;
  height: number;
}

interface AnnotationLayout {
  cards: DisplayCard[];
  labels: Rect[];
}

const layoutCache = new WeakMap<Hall, AnnotationLayout>();

/** Drawing and camera framing use the same measured, collision-cleared rectangles. */
function layoutAnnotations(hall: Hall): AnnotationLayout {
  const cached = layoutCache.get(hall);
  if (cached) return cached;
  const cards = planCards(hall.amenities ?? []).map((card) => {
    const layout = cardLayout(
      card.items.map((item) => item.label),
      (text, font) => measure(text, \x60700 \x24{font * PX_PER_M}px \x24{FONT_FAMILY}\x60) / PX_PER_M,
    );
    return { ...card, layout, width: layout.width, height: layout.height };
  });
  const labels = fixedAnnotationRects(hall.markers ?? [], hall.compass);
  let floors = floorOutlines(hall);
  if (!floors.length) {
    const { width, length } = planSize(hall);
    floors = [hall.shape === 'CIRCLE'
      ? Array.from({ length: 64 }, (_, i) => ({
          x: Math.cos(i * Math.PI / 32) * width / 2,
          z: Math.sin(i * Math.PI / 32) * length / 2,
        }))
      : [{ x: -width / 2, z: -length / 2 }, { x: width / 2, z: -length / 2 },
         { x: width / 2, z: length / 2 }, { x: -width / 2, z: length / 2 }]];
  }
  const result = { cards: placeAnnotationCards(cards, floors, labels), labels };
  layoutCache.set(hall, result);
  return result;
}

function buildCard(card: DisplayCard): THREE.Mesh {
  const captions = card.items.map((i) => i.label.toUpperCase());
  const captionFont = \x60700 \x24{CAPTION_FONT * PX_PER_M}px \x24{FONT_FAMILY}\x60;
  const { layout, anchor } = card;

` + text.slice(end);
const boundsStart = text.indexOf('export function annotationBounds(');
const boundsEnd = text.indexOf('// --- helpers', boundsStart);
if (boundsStart < 0 || boundsEnd < 0) throw new Error('Missing bounds');
text = text.slice(0, boundsStart) + `export function annotationBounds(hall: Hall): Rect | null {
  const { cards, labels } = layoutAnnotations(hall);
  const rects = [...cards.map((card) => annotationRect(card)), ...labels];
  if (!rects.length) return null;
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    minZ: Math.min(...rects.map((r) => r.minZ)),
    maxZ: Math.max(...rects.map((r) => r.maxZ)),
  };
}

function fixedAnnotationRects(
  markers: readonly HallMarker[],
  compass: HallCompass | null | undefined,
): Rect[] {
  const rects: Rect[] = [];
  for (const marker of markers) {
    const text = String(marker?.text ?? '').trim();
    if (!text || !Number.isFinite(marker.position?.x) || !Number.isFinite(marker.position?.z))
      continue;
    rects.push(annotationRect({ anchor: marker.position, ...textSize(text, EXIT_LABEL_FONT, '600') }));
  }
  if (compass && Number.isFinite(compass.position?.x) && Number.isFinite(compass.position?.z)) {
    const angle = compass.rotation * Math.PI / 180;
    const half = (compass.size > 0 ? compass.size : 5) / 2 *
      (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
    rects.push({
      minX: compass.position.x - half, maxX: compass.position.x + half,
      minZ: compass.position.z - half, maxZ: compass.position.z + half,
    });
    rects.push(annotationRect({
      anchor: {
        x: compass.position.x + compass.labelOffset.x,
        z: compass.position.z + compass.labelOffset.z,
      },
      ...textSize(compass.label || 'N', COMPASS_LABEL_FONT, '700'),
    }));
  }
  return rects;
}

` + text.slice(boundsEnd);
replace('function flatText(', `function textSize(text: string, font: number, weight: string): { width: number; height: number } {
  const css = \x60\x24{weight} \x24{font * PX_PER_M}px \x24{FONT_FAMILY}\x60;
  return {
    width: Math.ceil(measure(text, css) + 0.2 * PX_PER_M) / PX_PER_M,
    height: Math.ceil(font * 1.25 * PX_PER_M + 0.2 * PX_PER_M) / PX_PER_M,
  };
}

function flatText(`);
replace("  canvas.width = Math.ceil(measure(text, css) + pad * 2);\n  canvas.height = Math.ceil(font * 1.25 * PX_PER_M + pad * 2);", "  const { width, height } = textSize(text, font, weight);\n  canvas.width = width * PX_PER_M;\n  canvas.height = height * PX_PER_M;");
replace('  const width = canvas.width / PX_PER_M;\n  const height = canvas.height / PX_PER_M;\n', '');
write(rendererPath, text);
const scenePath = 'src/app/planner/three/scene3d.component.ts';
let scene = fs.readFileSync(path.join(root, scenePath), 'utf8');
for (const [before, after] of [
  ['buildAmenityCards(hall.amenities ?? [])', 'buildAmenityCards(hall)'],
  ['annotationBounds(hall.amenities ?? [], hall.markers ?? [], hall.compass)', 'annotationBounds(hall)'],
]) {
  if (!scene.includes(before)) throw new Error('Missing scene anchor: ' + before);
  scene = scene.replace(before, after);
}
write(scenePath, scene);
console.log('Updated annotation display layout and camera bounds.');
