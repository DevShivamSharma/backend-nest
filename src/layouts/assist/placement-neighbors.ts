import { polygonBounds, type PlacementStall, type Rect } from '../placement/placement-rules';
import { stallPolygon } from '../placement/polygon-geometry';

/** Conservative broad phase. Final acceptance still uses the polygon placement validator. */
export class PlacementNeighbors {
  private readonly cells = new Map<string, Set<PlacementStall>>();
  private readonly all: PlacementStall[] = [];
  private readonly large: PlacementStall[] = [];
  private readonly bounds = new Map<PlacementStall, Rect>();
  constructor(private readonly cellSize: number, stalls: readonly PlacementStall[]) { stalls.forEach(stall => this.add(stall)); }

  add(stall: PlacementStall): void {
    if (stall.status === 'CANCELLED') return;
    const bounds = polygonBounds(stallPolygon(stall));
    this.all.push(stall); this.bounds.set(stall, bounds);
    const cells = this.cellBounds(bounds);
    if ((cells.maxX-cells.minX+1)*(cells.maxZ-cells.minZ+1) > 4096) { this.large.push(stall); return; }
    for (let x=cells.minX; x<=cells.maxX; x++) for (let z=cells.minZ; z<=cells.maxZ; z++) {
      const key=`${x},${z}`, bucket=this.cells.get(key) ?? new Set<PlacementStall>();
      bucket.add(stall); this.cells.set(key,bucket);
    }
  }

  query(rect: Rect, reach: number): PlacementStall[] {
    const box={minX:rect.minX-reach-1e-6,maxX:rect.maxX+reach+1e-6,minZ:rect.minZ-reach-1e-6,maxZ:rect.maxZ+reach+1e-6};
    const cells=this.cellBounds(box);
    if ((cells.maxX-cells.minX+1)*(cells.maxZ-cells.minZ+1)>4096) return this.all.slice();
    const found=new Set(this.large);
    for(let x=cells.minX;x<=cells.maxX;x++) for(let z=cells.minZ;z<=cells.maxZ;z++)
      for(const stall of this.cells.get(`${x},${z}`) ?? []) found.add(stall);
    return [...found].filter(stall=>{
      const b=this.bounds.get(stall)!;
      return b.minX<=box.maxX && b.maxX>=box.minX && b.minZ<=box.maxZ && b.maxZ>=box.minZ;
    });
  }

  private cellBounds(rect: Rect): Rect {
    return {minX:Math.floor(rect.minX/this.cellSize),maxX:Math.floor(rect.maxX/this.cellSize),minZ:Math.floor(rect.minZ/this.cellSize),maxZ:Math.floor(rect.maxZ/this.cellSize)};
  }
}
