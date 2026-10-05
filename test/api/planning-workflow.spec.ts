import '../setup-env';
import { test, expect } from '@playwright/test';
const rect=(x:number,z:number,w:number,l:number)=>[{x,z},{x:x+w,z},{x:x+w,z:z+l},{x,z:z+l}];
const hall={name:'Meeting API hall',shape:'SQUARE',width:40,length:40,rules:{},planningZones:[
  {id:'expo',label:'Exhibition',kind:'EXHIBITION',eventType:'B2B',color:'#0e7490',polygon:rect(-18,-18,36,28)},
  {id:'admin',label:'Admin',kind:'ADMIN',eventType:'B2B',polygon:rect(-18,12,12,6)},
]};
const stall={name:'Standard',width:6,length:6,height:3,posX:0,posZ:0,openSides:['FRONT']};
let ids:number[]=[];
test.afterEach(async({request})=>{for(const id of ids)await request.delete('/api/layout/'+id);ids=[];});

test('zones round-trip, reject invalid save, publish numbers and return to draft on edit',async({request})=>{
  const data={layoutName:'Meeting API workflow',hall,stalls:[stall]};
  const create=await request.post('/api/layout/save',{data});expect(create.status(),await create.text()).toBe(201);
  const saved=await create.json(),id=saved.layout.id;ids.push(id);
  const read=await(await request.get('/api/layout/'+id)).json();expect(read.hall.planningZones).toEqual(hall.planningZones);expect(read.layout.status).toBe('DRAFT');
  const bad=await request.put('/api/layout/'+id,{data:{...data,stalls:[{...stall,posX:-12,posZ:15}]}});expect(bad.status()).toBe(400);expect((await bad.json()).violations.some((v:any)=>v.code==='INTERNAL_ZONE')).toBe(true);
  const publish=await request.post('/api/layout/'+id+'/publish',{data:{...data,stalls:saved.stalls}});expect(publish.status(),await publish.text()).toBe(200);
  const result=await publish.json();expect(result.layout.status).toBe('PUBLISHED');expect(result.layout.publishedAt).toBeTruthy();expect(result.layout.publishOverrides).toBeNull();expect(result.stalls[0].stallNumber).toBeTruthy();
  expect((await(await request.get('/api/layouts')).json()).find((l:any)=>l.id===id).status).toBe('PUBLISHED');
  const edit=await request.put('/api/layout/'+id,{data:{...data,layoutName:'Revised draft',stalls:result.stalls}});expect(edit.status()).toBe(200);expect((await edit.json()).layout).toMatchObject({status:'DRAFT',publishedAt:null,publishOverrides:null});
});
test('publish with violations requires a reason and persists the reviewed issues',async({request})=>{
  const data={hall,stalls:[stall,{...stall,name:'Overlap'}]};
  const rejected=await request.post('/api/layout/publish',{data});expect(rejected.status()).toBe(400);
  expect((await rejected.json()).violations.some((v:any)=>v.code==='STALL_OVERLAP')).toBe(true);
  const published=await request.post('/api/layout/publish',{data:{...data,overrideReason:'Reviewed demo overlap; resolve before allocation.'}});expect(published.status(),await published.text()).toBe(201);
  const result=await published.json();ids.push(result.layout.id);
  const read=await(await request.get('/api/layout/'+result.layout.id)).json();expect(read.layout.publishOverrides.reason).toContain('Reviewed demo');expect(read.layout.publishOverrides.issues.some((v:any)=>v.code==='STALL_OVERLAP')).toBe(true);
  expect(new Set(read.stalls.map((s:any)=>s.stallNumber)).size).toBe(2);
});
test('empty publish and malformed zones never write a layout',async({request})=>{
  const before=(await(await request.get('/api/layouts')).json()).length;
  for(const data of [{hall,stalls:[]},{hall:{...hall,planningZones:[{...hall.planningZones[0],polygon:rect(0,0,100,100)}]},stalls:[stall],overrideReason:'Cannot override structural errors'}]){
    expect((await request.post('/api/layout/publish',{data})).status()).toBe(400);
  }
  expect((await(await request.get('/api/layouts')).json()).length).toBe(before);
});
test('70% cap is authoritative at publish, even without planning zones',async({request})=>{
  const data={hall:{...hall,planningZones:[],rules:{peripheralClearance:0,enabledRules:{cornerKeepOut:false,openSideAccess:false}}},stalls:[{...stall,width:36,length:36}]};
  const response=await request.post('/api/layout/publish',{data});expect(response.status()).toBe(400);
  expect((await response.json()).violations.some((v:any)=>v.code==='MAX_UTILIZATION')).toBe(true);
});
