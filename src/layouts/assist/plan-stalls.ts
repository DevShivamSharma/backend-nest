import { buildPlacementContext, effectiveRules } from '../placement/hall-geometry';
import { extraFloorRegions, footprintRect, pointInPolygon, polygonBounds, rectInsidePolygon, traceFloor, validatePlacement, type Point, type Rect, type PlacementStall } from '../placement/placement-rules';
import type { AssistRequest } from './assist-request';
import type { LayoutIntent, RuleChanges } from './intent';
import { difference, type MultiPolygon } from 'polygon-clipping';
import { ring } from '../placement/polygon-geometry';

export interface AssistPlan {
  summary: string;
  notes: string[];
  stalls: (PlacementStall & { name: string; height: number; color: string })[];
  action: LayoutIntent['action'];
  requestedCount: number | null;
  placedCount: number;
  clarification?: string | null;
  removals?: { id: string; name: string }[];
  /** action "rules": the proposed rule changes, applied by the planner after review. */
  rules?: RuleChanges | null;
  source?: string;
}

/** Pure proposal builder. It never writes a layout or modifies caller-owned data. */
export function planStalls(intent: LayoutIntent, request: AssistRequest): AssistPlan {
  const result: AssistPlan = { summary: '', notes: [], stalls: [], action: intent.action, requestedCount: intent.count, placedCount: 0, clarification: intent.clarification };
  if (intent.clarification || intent.action === 'none') { result.summary = intent.clarification ?? 'No changes proposed.'; return result; }
  if (intent.action === 'rules') { result.rules = intent.rules; result.summary = 'Here are the rule changes. Nothing changes until you apply them.'; return result; }
  const hall = request.hall;
  const existing = request.existingStalls.map((s, i) => ({ ...s, id: String(s.id ?? `existing-${i}`) }));
  const ctx = buildPlacementContext(hall, hall.eventType ?? 'B2B', existing);
  // The interactive planner applies its default wall clearance even on legacy halls.
  // Proposals meet that stricter preview rule; existing save behavior is untouched.
  ctx.rules = { ...ctx.rules, peripheralClearance: effectiveRules(hall.rules).peripheralClearance };
  // Subtract fixed obstacles once. Passing an equivalent usable polygon to the unchanged
  // validator avoids repeating hundreds of mask subtractions for every scan position.
  let usable: MultiPolygon = ctx.circleRadius == null ? [ring(ctx.boundary!)] : [];
  for (const obstacle of ctx.obstacles ?? []) if (usable.length) usable = difference(usable, ring(obstacle));
  const contexts = ctx.circleRadius != null ? [ctx] : usable.map(poly => ({...ctx,boundary:poly[0].slice(0,-1).map(([x,z])=>({x,z})),obstacles:poly.slice(1).map(r=>r.slice(0,-1).map(([x,z])=>({x,z})))}));
  const width = Number(hall.width) || Number(hall.radius) * 2, length = Number(hall.length) || Number(hall.radius) * 2;
  const floor = traceFloor(hall.blockedAreas ?? [], width, length);
  // Regions guide the search only. The authoritative context still rejects anything outside
  // the persisted hall boundary, even when a source drawing contains another floor island.
  const regions = floor.length ? [floor[0].outer, ...extraFloorRegions(floor[0].outer, floor)] : [ctx.boundary!];
  let target: Rect = polygonBounds(ctx.boundary!);
  let targetRegion: Point[] | undefined;
  let center: Point | undefined;
  if (intent.area.type === 'rect') target = intent.area.rect!;
  if (intent.area.type === 'near_marker' || intent.area.type === 'region') {
    const name = intent.area.marker!.toLowerCase();
    const markers = hall.markers ?? [];
    const exact = markers.filter(m => m.text.toLowerCase() === name);
    const matches = exact.length ? exact : markers.filter(m => m.text.toLowerCase().includes(name));
    if (matches.length !== 1) {
      result.clarification = matches.length ? `Which marker do you mean: ${matches.map(m => m.text).join(', ')}?` : `I could not find “${intent.area.marker}”. Choose a marker shown in this hall.`;
      result.summary = result.clarification; return result;
    }
    center = matches[0].position;
    targetRegion = regions.find(r => pointInPolygon(center!, r));
    // Labels often sit just outside a foyer's floor; select the nearest traced region.
    if (!targetRegion) {
      const candidates = intent.area.type === 'region' && /foyer/i.test(name) && regions.length > 1 ? regions.slice(1) : regions;
      targetRegion = [...candidates].sort((a,b) => distanceToBounds(center!, polygonBounds(a)) - distanceToBounds(center!, polygonBounds(b)))[0];
    }
    const bounds = polygonBounds(targetRegion);
    if (intent.area.type === 'region') target = bounds;
    else {
      const radius = Math.max(12, Math.sqrt((intent.count ?? 20) * (intent.stallSize.width + 4) * (intent.stallSize.length + 4)) / 2);
      target = { minX: Math.max(bounds.minX, center.x-radius), maxX: Math.min(bounds.maxX, center.x+radius), minZ: Math.max(bounds.minZ, center.z-radius), maxZ: Math.min(bounds.maxZ, center.z+radius) };
    }
  }
  const minimum = ctx.rules.minPassageWidth[ctx.eventType];
  const aisle = Math.max(minimum, intent.aisleWidth ?? minimum);
  if (intent.aisleWidth != null && intent.aisleWidth < minimum) result.notes.push(`The hall requires at least ${minimum} m aisles; that minimum was kept.`);
  const { width: w, length: l } = intent.stallSize;
  const strip = Math.max(w, l) * 3 + aisle * 3 + ctx.rules.peripheralClearance;
  const bounds = { ...target };
  const wall = intent.area.wall;
  if (wall === 'west') target.maxX = Math.min(target.maxX, target.minX + strip);
  if (wall === 'east') target.minX = Math.max(target.minX, target.maxX - strip);
  if (wall === 'north') target.maxZ = Math.min(target.maxZ, target.minZ + strip);
  if (wall === 'south') target.minZ = Math.max(target.minZ, target.maxZ - strip);
  if (intent.action === 'clear') {
    result.removals = existing.filter(s => s.status !== 'CANCELLED' && inRect(s.posX,s.posZ,target) && (!targetRegion || pointInPolygon({x:s.posX,z:s.posZ},targetRegion))).slice(0,intent.count ?? 2000).map(s => ({ id:s.id, name:s.name ?? s.id }));
    result.summary = `Proposed removal of ${result.removals.length} stalls. Review and apply to confirm.`;
    result.notes.push('Nothing has been removed.'); return result;
  }
  const step = Math.max(.25, hall.rules?.snapStep ?? 1);
  if ([w,l].some(v => Math.abs(v/step-Math.round(v/step)) > 1e-6)) { result.summary = `Stall dimensions must fit the ${step} m snap grid.`; return result; }
  const gridBounds = floor.length ? {
    minX: Math.min(-width/2,...regions.map(r=>polygonBounds(r).minX),...(hall.blockedAreas??[]).filter(a=>a.kind!=='outside').map(a=>a.posX-a.width/2)),
    minZ: Math.min(-length/2,...regions.map(r=>polygonBounds(r).minZ),...(hall.blockedAreas??[]).filter(a=>a.kind!=='outside').map(a=>a.posZ-a.length/2))
  } : polygonBounds(ctx.boundary!);
  const snap = (v: number, origin: number) => origin+Math.ceil((v-origin-1e-7)/step)*step;
  const xs: number[] = [], zs: number[] = [];
  for (let x = snap(target.minX,gridBounds.minX); x+w <= target.maxX+1e-6 && xs.length < 8001; x+=step) xs.push(x+w/2);
  for (let z = snap(target.minZ,gridBounds.minZ); z+l <= target.maxZ+1e-6 && zs.length < 8001; z+=step) zs.push(z+l/2);
  if (wall === 'east') xs.reverse();
  if (wall === 'south') zs.reverse();
  if (center) { xs.sort((a,b)=>Math.abs(a-center!.x)-Math.abs(b-center!.x)); zs.sort((a,b)=>Math.abs(a-center!.z)-Math.abs(b-center!.z)); }
  const vertical = wall === 'west' || wall === 'east';
  const rowLimit = Number(request.requirement.match(/\b(\d+)\s+rows?\b/i)?.[1] ?? 0);
  const rows = new Set<number>();
  const reasons = new Map<string, number>();
  let attempts = 0;
  const deadline = Date.now() + 3500;
  outer: for (const row of vertical ? xs : zs) {
    if (rowLimit && rows.size >= rowLimit && !rows.has(row)) break;
    for (const col of vertical ? zs : xs) {
      const x = vertical ? row : col, z = vertical ? col : row;
      if (++attempts > 12000 || Date.now() > deadline) { result.notes.push('The bounded search stopped. Ask for a smaller area to continue.'); break outer; }
      if (intent.arrangement === 'perimeter' && Math.min(x-bounds.minX,bounds.maxX-x,z-bounds.minZ,bounds.maxZ-z) > strip/2) continue;
      let open = intent.openSide ?? (wall === 'west' ? 'RIGHT' : wall === 'east' ? 'LEFT' : wall === 'south' || (center && z>(bounds.minZ+bounds.maxZ)/2) ? 'BACK' : 'FRONT');
      if (intent.arrangement === 'back_to_back' && !intent.openSide) open = (rows.has(row)?[...rows].indexOf(row):rows.size) % 2 ? 'FRONT' : 'BACK';
      const candidate = { id: `proposal-${result.stalls.length+1}`, name: `${intent.namePrefix ?? 'AI'}-${existing.length+result.stalls.length+1}`, posX: +x.toFixed(6), posZ: +z.toFixed(6), width:w, length:l, rotation:0, openSides:intent.arrangement==='island'&&!intent.openSide?['FRONT','BACK','LEFT','RIGHT']:[open], height:4, color:'#3498db' };
      if (targetRegion && !rectInsidePolygon(footprintRect(candidate), targetRegion)) continue;
      // Respect requested aisles in addition to the hall's mandatory placement rules.
      if (result.stalls.some(s => {
        const dx=Math.max(0,Math.abs(s.posX-x)-w), dz=Math.max(0,Math.abs(s.posZ-z)-l);
        const backs = intent.arrangement === 'back_to_back' && Math.abs(s.posX-x)<1e-6 && Math.abs(Math.abs(s.posZ-z)-l)<1e-6 && s.openSides?.[0] !== open;
        return !backs && Math.hypot(dx,dz)<aisle-1e-6;
      })) continue;
      const local = contexts.find(c=>!c.boundary || rectInsidePolygon(footprintRect(candidate),c.boundary));
      if (!local) { reasons.set('OUTSIDE_HALL',1); continue; }
      const validation = validatePlacement(candidate, { ...local, rules: { ...ctx.rules, minPassageWidth: {...ctx.rules.minPassageWidth, [ctx.eventType]:aisle} }, stalls:[...existing,...result.stalls] });
      if (!validation.valid) { for (const v of validation.violations) reasons.set(v.code,(reasons.get(v.code)??0)+1); continue; }
      result.stalls.push(candidate); rows.add(row);
      if (result.stalls.length >= (intent.count ?? 500)) break outer;
    }
  }
  result.placedCount = result.stalls.length;
  result.summary = `Proposed ${result.placedCount}${intent.count ? ` of ${intent.count}` : ''} stalls, ${w} × ${l} m, with ${aisle} m aisles.`;
  if (result.placedCount < (intent.count ?? 501)) {
    const labels: Record<string,string> = { OUTSIDE_HALL:'hall boundary / walls', RESTRICTED_ZONE:'restricted zones', PATHWAY_WIDTH:'passage width', OPEN_SIDE_PASSAGE:'open-side access', PERIPHERAL_CLEARANCE:'wall clearance', CORNER_PASSAGE:'corner passage', STALL_OVERLAP:'existing stalls', OPEN_SIDE_BLOCKED:'blocked entrances' };
    result.notes.push(`Fit is limited by available space${reasons.size ? ` and ${[...reasons.keys()].slice(0,4).map(k=>labels[k]??k.toLowerCase().replace(/_/g,' ')).join(', ')}` : ''}.`);
  }
  if (intent.count === null && result.stalls.length === 500) result.notes.push('POC limit: 500 stalls per proposal.');
  result.notes.push('Outlines are a preview. Apply rechecks the current hall before adding stalls.');
  return result;
}
function inRect(x:number,z:number,r:Rect) { return x>=r.minX && x<=r.maxX && z>=r.minZ && z<=r.maxZ; }
function distanceToBounds(p:Point,r:Rect) { return Math.hypot(Math.max(r.minX-p.x,0,p.x-r.maxX),Math.max(r.minZ-p.z,0,p.z-r.maxZ)); }
