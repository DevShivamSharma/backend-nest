import { validateHallGeometry, buildPlacementContext } from './hall-geometry';
import { validatePlacement, type PlacementContext, type Footprint } from './placement-rules';
import { planningZoneFor, utilization, type PlanningZone } from './planning-zones';
import { prepublishReport, emptySpaceSuggestions } from './publish-check';
import { planStalls } from '../assist/plan-stalls';
import { parseSimple } from '../assist/intent';
import { validateRequest, type AssistRequest } from '../assist/assist-request';

const rect = (x:number,z:number,w:number,l:number) => [{x,z},{x:x+w,z},{x:x+w,z:z+l},{x,z:z+l}];
const zone = (id:string,x:number,z:number,w:number,l:number,kind:PlanningZone['kind']='EXHIBITION',eventType:PlanningZone['eventType']='B2B'):PlanningZone => ({id,label:id,kind,eventType,polygon:rect(x,z,w,l)});
const stall = (posX=0,posZ=0):Footprint => ({posX,posZ,width:2,length:2,openSides:['FRONT']});
const hall = () => ({name:'Workflow hall',shape:'SQUARE',width:60,length:60,rules:{peripheralClearance:0,minPassageWidth:{B2B:1.5,B2C:1.5}}});
const context = ():PlacementContext => buildPlacementContext(hall(),'B2B',[]);
const codes = (s:Footprint,c:PlacementContext) => validatePlacement(s,c).violations.map(v=>v.code);

describe('planning zones and utilization',()=>{
  it('retains custom zone colours and rejects malformed colour values',()=>{
    const z={...zone('Colour',-10,-10,10,10),color:'#12ABEF'};
    expect(validateHallGeometry({...hall(),planningZones:[z]}).planningZones?.[0]).toEqual({...z,color:'#12abef'});
    for(const color of ['red','#fff','#zz1234','url(test)',123]) expect(()=>validateHallGeometry({...hall(),planningZones:[{...z,color}]})).toThrow(/colour/);
  });
  it('accepts touching zones but rejects overlaps and zones beyond the hall',()=>{
    const a=zone('A',-20,-20,20,20),b=zone('B',0,-20,20,20);
    expect(validateHallGeometry({...hall(),planningZones:[a,b]}).planningZones).toEqual([a,b]);
    expect(()=>validateHallGeometry({...hall(),planningZones:[a,{...b,polygon:rect(-1,-20,20,20)}]})).toThrow(/overlaps/);
    expect(()=>validateHallGeometry({...hall(),planningZones:[zone('outside',25,25,10,10)]})).toThrow(/inside/);
  });
  it.each([
    [{...zone('a',0,0,10,10),kind:'VIP'}],
    [zone('a',0,0,10,10),zone('a',10,0,10,10)],
    [{...zone('a',0,0,10,10),eventType:'B2X'}],
    [{...zone('a',0,0,10,10),label:' '}],
    [{...zone('a',0,0,10,10),polygon:[{x:NaN,z:0},{x:2,z:0},{x:2,z:2}]}],
    [{...zone('a',0,0,10,10),polygon:[{x:0,z:0},{x:10,z:10},{x:0,z:10},{x:10,z:0}]}],
  ].map(zones=>({zones})))('rejects malformed zone set %#',({zones})=>expect(()=>validateHallGeometry({...hall(),planningZones:zones})).toThrow());
  it('blocks internal zones and straddling sellable boundaries, including rotated stalls',()=>{
    const c=context();c.planningZones=[zone('Media',-20,-20,10,10,'MEDIA'),zone('Expo',0,0,20,20)];
    expect(codes(stall(-15,-15),c)).toContain('INTERNAL_ZONE');
    expect(codes(stall(0,10),c)).toContain('ZONE_BOUNDARY');
    expect(codes({...stall(1,10),rotation:45},c)).toContain('ZONE_BOUNDARY');
    expect(codes(stall(10,10),c)).toEqual([]);
    c.rules.enabledRules={internalZones:false};expect(codes(stall(-15,-15),c)).not.toContain('INTERNAL_ZONE');
  });
  it('uses actual stall edges for B2B/B2C distance and ignores cancelled stalls',()=>{
    const c=context();c.planningZones=[zone('B2B',-20,-20,20,40),zone('B2C',0,-20,20,40,'FOOD','B2C')];
    c.stalls=[{...stall(-2.5,0),id:'a'}];
    expect(codes(stall(2.5,0),c)).not.toContain('EVENT_SEPARATION');
    expect(codes(stall(2.49,0),c)).toContain('EVENT_SEPARATION');
    c.stalls[0].status='CANCELLED';expect(codes(stall(2.49,0),c)).not.toContain('EVENT_SEPARATION');
  });
  it('computes polygon floor minus obstacles and custom footprints, excluding cancellations',()=>{
    const c=context();c.boundary=rect(-10,-10,20,20);c.obstacles=[rect(0,0,5,5)];
    c.stalls=[{...stall(-5,-5),id:'a',width:4,length:4,footprint:rect(-2,-2,2,4)}, {...stall(5,5),id:'b',status:'CANCELLED'}];
    expect(utilization(c)).toMatchObject({floorArea:375,usedArea:8,limit:.7,exceeded:false});
    expect(utilization({...c,circleRadius:10,obstacles:[]}).floorArea).toBeCloseTo(Math.PI*100,6);
  });
  it('reports the 70% cap, disabled rules and checked empty-space alternatives',()=>{
    const c=context();expect(emptySpaceSuggestions(c).length).toBeGreaterThan(0);
    c.rules.enabledRules={cornerKeepOut:false};c.stalls=[{...stall(),id:'large',width:52,length:52}];
    expect(prepublishReport(c).issues.map(i=>i.code)).toEqual(expect.arrayContaining(['MAX_UTILIZATION','DISABLED_RULE']));
    expect(emptySpaceSuggestions(c)).toEqual([]);
    for(const rules of [{maxUtilization:.71},{eventSeparation:2.99}])expect(()=>validateHallGeometry({...hall(),rules})).toThrow();
  });
});

describe('zone-aware AI cutting',()=>{
  const request=():AssistRequest=>({requirement:'Fill the hall with 6x6 stalls',hall:{...hall(),planningZones:[
    zone('small',-28,-28,12,18,'FOOD','B2C'),zone('large',-10,-28,36,54),zone('media',-28,0,12,12,'MEDIA'),
  ]},existingStalls:[]});
  it('fills the biggest sellable zone first and respects all final placements and the cap',()=>{
    const req=request(),before=JSON.stringify(req),result=planStalls(parseSimple(req.requirement),req);
    expect(result.stalls.length).toBeGreaterThan(12);
    expect(planningZoneFor(result.stalls[0],req.hall.planningZones!)?.id).toBe('large');
    expect(result.stalls.some(s=>planningZoneFor(s,req.hall.planningZones!)?.id==='small')).toBe(true);
    const c=buildPlacementContext(req.hall,'B2B',result.stalls);
    for(const s of result.stalls) expect(validatePlacement(s,c,s.id).violations).toEqual([]);
    expect(utilization(c).exceeded).toBe(false);expect(JSON.stringify(req)).toBe(before);
  });
  it('keeps a selected zone and never proposes stalls in internal areas even with checks off',()=>{
    const req=request();req.zoneId='small';req.hall.rules={...req.hall.rules,enabledRules:{internalZones:false}};
    const result=planStalls(parseSimple(req.requirement),req);
    expect(result.stalls.length).toBeGreaterThan(0);
    expect(result.stalls.every(s=>planningZoneFor(s,req.hall.planningZones!)?.id==='small')).toBe(true);
    expect(()=>validateRequest({...req,zoneId:'media'})).toThrow(/Food or Exhibition/);
  });
  it('stops exactly at remaining utilization capacity, including existing stalls',()=>{
    const req:AssistRequest={requirement:'Fill the hall with 3x3 stalls',hall:{...hall(),width:30,length:30,rules:{maxUtilization:.1,peripheralClearance:0}},existingStalls:[{...stall(),width:3,length:3,id:'old'}]};
    const result=planStalls(parseSimple(req.requirement),req);
    expect(result.stalls).toHaveLength(9);
    req.existingStalls.push(...result.stalls);
    expect(planStalls(parseSimple(req.requirement),req).stalls).toHaveLength(0);
  });
});
