import { BadRequestException } from '@nestjs/common';
import { buildPlacementContext, validateHallGeometry } from '../placement/hall-geometry';
import type { HallMarker } from '../entities/hall.entity';
import type { PlacementStall, EventType } from '../placement/placement-rules';
import { normalizeFootprint, normalizeOpenEdges } from '../placement/stall-footprint';

export interface AssistRequest {
  requirement: string;
  hall: Parameters<typeof buildPlacementContext>[0] & { id?: string | number; name: string; gridCell?: number; markers?: HallMarker[] | null; eventType?: EventType };
  existingStalls: (Omit<PlacementStall, 'id'> & { id?: string | number; name?: string })[];
}

export function validateRequest(raw: unknown): AssistRequest {
  const fail = (message: string): never => { throw new BadRequestException(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Expected an assistant request.');
  const v = raw as AssistRequest;
  if (typeof v.requirement !== 'string' || !v.requirement.trim() || v.requirement.length > 500) return fail('Requirement must contain 1–500 characters.');
  const h = v.hall;
  if (!h || typeof h.name !== 'string' || h.name.length > 255 || !['SQUARE', 'CIRCLE'].includes(h.shape ?? '')) return fail('A valid hall is required.');
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 2000;
  if (h.shape === 'CIRCLE' ? !positive(h.radius) : !positive(h.width) || !positive(h.length)) return fail('Hall dimensions must be positive and at most 2000 m.');
  if (h.gridCell != null && !positive(h.gridCell)) return fail('Invalid grid size.');
  if (h.eventType != null && !['B2B','B2C'].includes(h.eventType)) return fail('Invalid event type.');
  for (const field of ['blockedAreas','boundary','zones','openings','markers'] as const) {
    const items = h[field];
    if (items != null && (!Array.isArray(items) || items.length > 2000)) return fail(`Invalid hall ${field}.`);
  }
  if (h.boundary && h.boundary.length > 500) return fail('Hall boundary is too complex.');
  if (h.zones?.some(z => !z || !Array.isArray(z.polygon) || z.polygon.length > 500)) return fail('Invalid zone polygon.');
  try { validateHallGeometry(h); } catch { return fail('Hall geometry or rules are invalid.'); }
  if (!Array.isArray(v.existingStalls) || v.existingStalls.length > 2000) return fail('At most 2000 existing stalls are supported.');
  for (const s of v.existingStalls) {
    if (!s || !positive(s.width) || !positive(s.length) || ![s.posX,s.posZ,s.rotation ?? 0].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000) ||
      (s.id != null && !['string','number'].includes(typeof s.id)) || (s.name != null && (typeof s.name !== 'string' || s.name.length > 255)) ||
      (s.status != null && !['AVAILABLE','BOOKED','CANCELLED'].includes(s.status)) ||
      (s.openSides != null && (!Array.isArray(s.openSides) || s.openSides.length > 4 || s.openSides.some(x => !['FRONT','BACK','LEFT','RIGHT'].includes(x)))) ||
      (s.gateSide != null && !['FRONT','BACK','LEFT','RIGHT'].includes(s.gateSide))) return fail('Invalid existing stall.');
    // A custom (e.g. L-shaped) stall: planning must avoid its real outline, not its box.
    if (s.footprint != null) {
      const n = normalizeFootprint(s.footprint);
      if (typeof n === 'string') return fail('Invalid existing stall.');
      const edges = normalizeOpenEdges(s.openEdges, n.points.length);
      if (typeof edges === 'string' || n.points.length !== s.footprint.length) return fail('Invalid existing stall.');
    } else if (s.openEdges != null) return fail('Invalid existing stall.');
  }
  return v;
}
