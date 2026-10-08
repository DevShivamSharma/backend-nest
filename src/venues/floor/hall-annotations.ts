import { BadRequestException } from '@nestjs/common';
import type { HallAnnotationsDto } from '../dto/hall-annotations.dto';
import { cleanColor, cleanText, HallFloor } from './hall-floor';
import { rectangle } from '../floor-plan/geometry';

/** Helpers describe the floor without changing its bookable footprint. */
export function withAnnotations(floor: HallFloor, input: HallAnnotationsDto): HallFloor {
  const text = (value: string) => {
    const result = cleanText(value);
    if (!result) throw new BadRequestException('Helper text and legend names cannot be empty.');
    return result;
  };
  const next: HallFloor = {
    ...floor,
    labels: input.labels.map((l) => ({ ...l, text: text(l.text) })),
    iconGroups: input.iconGroups.map((g) => ({
      ...g,
      icons: g.icons.map((i) => ({ kind: i.kind, label: text(i.label) })),
    })),
    legend: input.legend.map((l) => ({
      label: text(l.label),
      ...(l.color ? { color: cleanColor(l.color) } : {}),
      showInView: l.showInView,
    })),
  };
  // Blank floors created before the Three.js viewer have no geometry member.
  if (!next.geometry && !next.areas.length && !next.zones?.length) {
    const boundary = rectangle(0, 0, next.width, next.depth);
    next.geometry = {
      schema: 'geometry/1',
      unit: 'm',
      boundary,
      hallBoundary: boundary,
      grid: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      objects: [],
      zones: [],
      source: { documentId: 'manual', page: 1, regionId: 'hall', origin: [0, 0], metresPerUnit: 1 },
      review: { revision: 1, checks: [], acknowledgements: [] },
    };
  }
  return next;
}
