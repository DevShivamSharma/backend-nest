import { PlacementRejectedError } from '../../common/errors/domain.errors';
import { buildPlacementContext } from './hall-geometry';
import { validatePlacement, type EventType, type PlacementStall } from './placement-rules';

/** Shared final validation for layout writes and edits of a hall already owned by a layout. */
export function assertPlacements(
  hall: Parameters<typeof buildPlacementContext>[0],
  eventType: EventType,
  stalls: Array<Omit<PlacementStall, 'id'> & { name?: string | null }>,
): void {
  const placements = stalls.map((stall, i) => ({ ...stall, id: String(i) }));
  const ctx = buildPlacementContext(hall, eventType, placements);
  const problems: Array<Record<string, unknown>> = [];
  let message = '';
  for (const [index, stall] of placements.entries()) {
    if (stall.status === 'CANCELLED') continue;
    for (const violation of validatePlacement(stall, ctx, String(index)).violations) {
      if (!message)
        message = `Stall ${index} (${stall.name ?? 'Shop'}) placement rejected: ${violation.message}`;
      problems.push({ stallIndex: index, stallNumber: stall.stallNumber, ...violation });
    }
  }
  if (problems.length) throw new PlacementRejectedError(message, problems);
}
