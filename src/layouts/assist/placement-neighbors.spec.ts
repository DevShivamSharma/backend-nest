import { PlacementNeighbors } from './placement-neighbors';
import { buildPlacementContext } from '../placement/hall-geometry';
import { footprintRect, validatePlacement, type PlacementStall } from '../placement/placement-rules';

describe('placement neighbour broad phase',()=>{
  const stalls:PlacementStall[]=[
    {id:'rotated',posX:0,posZ:0,width:18,length:3,rotation:45,openSides:['LEFT','FRONT']},
    {id:'cancelled',posX:0,posZ:0,width:20,length:20,status:'CANCELLED'},
    {id:'custom',posX:20,posZ:0,width:8,length:6,footprint:[{x:-4,z:-3},{x:4,z:-3},{x:4,z:0},{x:0,z:0},{x:0,z:3},{x:-4,z:3}],openEdges:[0,1]},
  ];
  it('matches full-context acceptance around rotated footprints and open-edge corridors',()=>{
    const index=new PlacementNeighbors(8,stalls);
    const full=buildPlacementContext({shape:'SQUARE',width:100,length:100,rules:{}},'B2B',stalls);
    for(let x=-15;x<=35;x+=2.5) for(let z=-15;z<=15;z+=2.5) {
      const candidate={width:3,length:3,posX:x,posZ:z,openSides:['FRONT']};
      const nearby=index.query(footprintRect(candidate),3);
      expect(nearby.some(s=>s.id==='cancelled')).toBe(false);
      expect(validatePlacement(candidate,{...full,stalls:nearby}).valid).toBe(validatePlacement(candidate,full).valid);
    }
  });
  it('keeps very large footprints without unbounded cell allocation and tracks new placements',()=>{
    const large={id:'large',posX:0,posZ:0,width:100000,length:100000};
    const index=new PlacementNeighbors(8,[large]);
    const box={minX:1000,maxX:1003,minZ:1000,maxZ:1003};
    expect(index.query(box,3)).toContain(large);
    const added={id:'new',width:3,length:3,posX:1001,posZ:1001};index.add(added);
    expect(index.query(box,3)).toContain(added);
  });
});
