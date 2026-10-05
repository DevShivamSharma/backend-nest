import { auditLayout, polygonBounds, validatePlacement, type PlacementContext, type Violation } from './placement-rules';
import { planningZoneFor, utilization } from './planning-zones';

export interface PublishIssue {
  code: string;
  message: string;
  stallId?: string;
  violation?: Violation;
}
export function prepublishReport(ctx: PlacementContext, entries = auditLayout(ctx)) {
  const usage = utilization(ctx);
  const issues: PublishIssue[] = entries.flatMap(entry => entry.violations.map(violation => ({
    code: violation.code, message: `${entry.stallNumber ?? entry.stallId}: ${violation.message}`,
    stallId: entry.stallId, violation,
  })));
  if (usage.exceeded) issues.push({ code: 'MAX_UTILIZATION',
    message: `Stalls use ${(usage.ratio * 100).toFixed(1)}% of the hall; the limit is ${Math.round(usage.limit * 100)}%.` });
  for (const [rule, enabled] of Object.entries(ctx.rules.enabledRules ?? {})) {
    if (enabled === false) issues.push({ code: 'DISABLED_RULE', message: `Rule disabled: ${rule}.` });
  }
  return { usage, issues };
}

/** A few checked alternatives for a standard stall, not a simultaneous placement proposal. */
export function emptySpaceSuggestions(ctx: PlacementContext, size = 6) {
  const usage = utilization(ctx);
  if (!ctx.boundary || usage.usedArea + size * size > usage.floorArea * usage.limit + 1e-6) return [];
  const bounds = polygonBounds(ctx.boundary);
  const suggestions: Array<{ posX: number; posZ: number; width: number; length: number; label: string }> = [];
  let checks = 0;
  const step = Math.max(size, ctx.rules.snapStep);
  for (let z = bounds.minZ + size / 2; z <= bounds.maxZ - size / 2; z += step) {
    for (let x = bounds.minX + size / 2; x <= bounds.maxX - size / 2; x += step) {
      if (++checks > 600 || suggestions.length >= 3) return suggestions;
      const stall = { posX: x, posZ: z, width: size, length: size, openSides: ['FRONT' as const] };
      if (validatePlacement(stall, ctx).valid) suggestions.push({ ...stall,
        label: planningZoneFor(stall, ctx.planningZones ?? [])?.label ?? 'Hall floor' });
    }
  }
  return suggestions;
}
