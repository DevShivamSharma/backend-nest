import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { planStalls } from '../src/layouts/assist/plan-stalls';
import { parseSimple } from '../src/layouts/assist/intent';
import type { AssistRequest } from '../src/layouts/assist/assist-request';

const rect = (x:number,z:number,w:number,l:number) => [{x,z},{x:x+w,z},{x:x+w,z:z+l},{x,z:z+l}];
const cases: Record<string, AssistRequest> = {
  'large-hall': {requirement:'fill the hall with 3x3 stalls',hall:{name:'Benchmark',shape:'SQUARE',width:150,length:90,rules:{}},existingStalls:[]},
  'quarter-metre-grid': {requirement:'fill the hall with 3x2 stalls',hall:{name:'Fine grid',shape:'SQUARE',width:80,length:60,rules:{snapStep:.25}},existingStalls:[]},
  'two-event-zones': {requirement:'fill the hall with 3x3 stalls',hall:{name:'Zones',shape:'SQUARE',width:100,length:80,rules:{},planningZones:[
    {id:'a',kind:'EXHIBITION',label:'Large',eventType:'B2B',polygon:rect(-48,-38,60,76)},
    {id:'b',kind:'EXHIBITION',label:'Small',eventType:'B2C',polygon:rect(14,-38,34,76)}
  ]},existingStalls:[]}
};
const warmup = {...cases['large-hall'],requirement:'2 stalls of 3x3'};
planStalls(parseSimple(warmup.requirement),warmup);
const results = Object.entries(cases).map(([name, request]) => {
  const started = performance.now();
  const plan = planStalls(parseSimple(request.requirement),request);
  return {name,ms:Math.round(performance.now()-started),stalls:plan.placedCount,notes:plan.notes};
});
if(process.argv[2]) writeFileSync(process.argv[2],JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
