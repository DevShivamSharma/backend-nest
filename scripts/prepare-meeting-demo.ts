/** Create separate demo copies from the checked-in Hall 12A import; never edit the source hall. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planStalls } from '../src/layouts/assist/plan-stalls';
import { parseSimple } from '../src/layouts/assist/intent';
import { validateRequest, type AssistRequest } from '../src/layouts/assist/assist-request';
import { buildPlacementContext } from '../src/layouts/placement/hall-geometry';
import { effectiveRules } from '../src/layouts/placement/placement-rules';
import { prepublishReport } from '../src/layouts/placement/publish-check';
import type { PlanningZone } from '../src/layouts/placement/planning-zones';

const api = 'http://localhost:8080/api';
const zone = (id:string,label:string,kind:PlanningZone['kind'],eventType:PlanningZone['eventType'],x:number,z:number,w:number,l:number):PlanningZone => ({
  id,label,kind,eventType,polygon:[{x,z},{x:x+w,z},{x:x+w,z:z+l},{x,z:z+l}],
});
async function main() {
  const fixture=JSON.parse(readFileSync(join(__dirname,'data/meeting-hall12a.json'),'utf8'));
  const hall={...fixture.hall,name:'Hall 12A · meeting demo',rules:effectiveRules(fixture.hall.rules),planningZones:[
    zone('demo-exhibition','Exhibition','EXHIBITION','B2B',-49,-54,42,86),
    zone('demo-food','Food','FOOD','B2C',-4,22,48,30),
    zone('demo-media','Media','MEDIA','B2B',-49,38,12,12),
    zone('demo-admin','Admin','ADMIN','B2B',-34,38,12,12),
  ]};
  const requirement='Fill the hall with 6x6 stalls';
  const request:AssistRequest=validateRequest({requirement,hall,existingStalls:[]});
  const plan=planStalls(parseSimple(requirement),request);
  const report=prepublishReport(buildPlacementContext(hall,'B2B',plan.stalls));
  if(report.issues.length) throw new Error(JSON.stringify(report.issues));
  if(plan.stalls.length<30) throw new Error('Demo packing produced too few stalls; inspect before saving.');
  if(process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({stallCount:plan.stalls.length,usage:report.usage,notes:plan.notes},null,2));return;
  }
  const stamp=new Date().toISOString().slice(0,16).replace('T',' ');
  const create=async(name:string,stalls:unknown[],publish=false)=>{
    const response=await fetch(api+(publish?'/layout/publish':'/layout/save'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({layoutName:name+' · '+stamp,hall,stalls,eventType:'B2B'})});
    const saved=await response.json();if(!response.ok)throw Error(JSON.stringify(saved));return saved;
  };
  let editable, backup;
  if(process.argv.includes('--refresh')) {
    const previous=JSON.parse(readFileSync(join(__dirname,'data/meeting-demo-result.json'),'utf8'));
    editable=await(await fetch(api+'/layout/'+previous.startLayoutId)).json();
    const existing=await(await fetch(api+'/layout/'+previous.publishedLayoutId)).json();
    if(!existing.layout?.name?.startsWith('Hall 12A demo · published backup')) throw Error('The stored backup is no longer a meeting demo. Create a fresh pair.');
    const response=await fetch(api+'/layout/'+previous.publishedLayoutId+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      layoutName:existing.layout.name,hall,eventType:'B2B',stalls:plan.stalls.map((s,i)=>({...s,stallNumber:existing.stalls[i]?.stallNumber})),
    })});
    backup=await response.json();if(!response.ok)throw Error(JSON.stringify(backup));
  } else {
    editable=await create('Hall 12A demo · start with zones',[]);
    backup=await create('Hall 12A demo · published backup',plan.stalls,true);
  }
  const result={createdAt:new Date().toISOString(),source:fixture.source,startLayoutId:editable.layout.id,publishedLayoutId:backup.layout.id,stallCount:plan.stalls.length,utilization:report.usage,notes:plan.notes};
  writeFileSync(join(__dirname,'data/meeting-demo-result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
