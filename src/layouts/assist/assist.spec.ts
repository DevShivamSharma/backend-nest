import { ConfigService } from '@nestjs/config';
import { buildPlacementContext } from '../placement/hall-geometry';
import { validatePlacement } from '../placement/placement-rules';
import { parseSimple, validateIntent } from './intent';
import { planStalls } from './plan-stalls';
import { validateRequest, AssistRequest } from './assist-request';
import { AssistService } from './assist.service';
import { HttpIntentProvider, InvalidIntentError, RateLimitedError } from './intent-provider';

const request = (requirement='12 stalls of 3x3 along the left wall'): AssistRequest => ({requirement,hall:{name:'Test',shape:'SQUARE',width:80,length:60,rules:{},markers:[{text:'FOYER-1G',position:{x:15,z:10}}]},existingStalls:[]});
describe('assistant intent and fallback',()=>{
  it.each(['cut 20 stalls of 3x3 along the left wall, 4 m aisles','12 stalls of 3x3 near FOYER-1G','fill the foyer with 3x2 stalls'])('parses %s',text=>{expect(validateIntent(parseSimple(text)).action).toBe('place');});
  it('extracts count, wall, dimensions and aisle',()=>{expect(parseSimple('20 stalls of 3x2 along the left wall, 4 m aisles')).toMatchObject({count:20,stallSize:{width:3,length:2},area:{type:'along_wall',wall:'west'},aisleWidth:4});});
  it('asks for clarification when ambiguous',()=>{expect(parseSimple('make it nice').clarification).toBeTruthy();});
  it('clear is an intent, never a mutation',()=>{expect(parseSimple('clear all stalls').action).toBe('clear');});
  it.each([null,[],{},'{bad json}',{...parseSimple('3 stalls of 3x3'),coordinates:[]},{...parseSimple('3 stalls of 3x3'),count:1.5},{...parseSimple('3 stalls of 3x3'),stallSize:{width:-1,length:3}},{...parseSimple('3 stalls of 3x3'),area:{type:'near_marker'}},{...parseSimple('3 stalls of 3x3'),area:{type:'whole_hall',wall:'west'}}])('rejects invalid intent %#',v=>{expect(()=>validateIntent(v)).toThrow();});
  it('reads rule requests as rule changes, never as stalls',()=>{
    expect(parseSimple('set the passage width to 1.5 m')).toMatchObject({action:'rules',rules:{passageWidth:1.5}});
    expect(parseSimple('set the passage width to 1 m').action).toBe('none');
    expect(parseSimple('set the passage width to 4 m')).toMatchObject({action:'rules',rules:{passageWidth:4,wallClearance:null,notes:[]}});
    expect(parseSimple('wall clearance 2 m')).toMatchObject({action:'rules',rules:{wallClearance:2}});
    expect(parseSimple('add rule: corner stalls are premium')).toMatchObject({action:'rules',rules:{notes:['corner stalls are premium']}});
    expect(parseSimple('passage width 6 m').action).toBe('none');
    expect(parseSimple('20 stalls of 3x3 along the left wall, 4 m aisles').action).toBe('place');
  });
  it.each(['i want to add ruless','i want to add rules','add rules','change the passage width'])('asks which rule, never for a stall size: %s',text=>{
    const intent=parseSimple(text);
    expect(intent.action).toBe('none');expect(intent.rules).toBeUndefined();expect(intent.clarification).toMatch(/rule/i);expect(intent.clarification).not.toMatch(/stall size/i);
  });
  it('validates rule changes strictly',()=>{
    const rules=(r:object)=>({...parseSimple('set the passage width to 4 m'),rules:{enable:[],disable:[],passageWidth:null,wallClearance:null,notes:[],...r}});
    expect(validateIntent(rules({disable:['peripheralClearance']})).rules?.disable).toEqual(['peripheralClearance']);
    for(const bad of [{disable:['noSuchRule']},{enable:['FOYER'],disable:['FOYER']},{passageWidth:1},{notes:['']},{}]) expect(()=>validateIntent(rules(bad))).toThrow();
    // A stall request with an echoed rules object stays a stall request, without rule changes.
    expect(validateIntent({...parseSimple('3 stalls of 3x3'),rules:{enable:['FOYER'],disable:[],passageWidth:null,wallClearance:null,notes:[]}}).rules).toBeUndefined();
    const plan=planStalls(parseSimple('set the passage width to 4 m'),request());
    expect(plan).toMatchObject({action:'rules',stalls:[],rules:{passageWidth:4}});
  });
  it('bounds input length',()=>{expect(()=>validateRequest({...request(),requirement:'x'.repeat(501)})).toThrow();});
  it('rejects malformed hall and stall geometry',()=>{expect(()=>validateRequest({...request(),existingStalls:[{width:3}]})).toThrow();expect(()=>validateRequest({...request(),hall:{...request().hall,boundary:[{x:0,z:0}]}})).toThrow();});
});

describe('deterministic proposal planner',()=>{
  function check(req:AssistRequest) {
    const before=JSON.stringify(req), result=planStalls(parseSimple(req.requirement),req);
    const ctx=buildPlacementContext(req.hall,req.hall.eventType??'B2B',req.existingStalls.map((s,i)=>({...s,id:String(s.id??i)})));
    for(const s of result.stalls) {expect(validatePlacement(s,ctx).violations).toEqual([]);ctx.stalls.push(s);}
    expect(JSON.stringify(req)).toBe(before);return result;
  }
  it('honours count in rows along a wall',()=>{const result=check(request());expect(result.stalls).toHaveLength(12);expect(result.stalls.every(s=>s.posX<0)).toBe(true);});
  it('fills a fine snap grid beyond the old candidate limit without skipping placement rules',()=>{
    const req=request('fill the hall with 3x2 stalls'); req.hall.rules={snapStep:.25};
    const result=check(req);
    expect(result.stalls.length).toBeGreaterThan(250);
    expect(result.notes.join(' ')).not.toContain('bounded search stopped');
  });
  it.each(['back_to_back','island'] as const)('keeps %s proposals valid against rotated and custom existing stalls',arrangement=>{
    const req=request('30 stalls of 3x3');
    req.existingStalls=[
      {id:'rotated',posX:-20,posZ:-20,width:10,length:6,rotation:35,openSides:['LEFT','FRONT']},
      {id:'custom',posX:0,posZ:-20,width:8,length:6,footprint:[{x:-4,z:-3},{x:4,z:-3},{x:4,z:0},{x:0,z:0},{x:0,z:3},{x:-4,z:3}],openEdges:[0,1]},
    ];
    const result=planStalls({...parseSimple(req.requirement),arrangement},req);
    expect(result.stalls.length).toBe(30);
    const ctx=buildPlacementContext(req.hall,'B2B',[...req.existingStalls.map(s=>({...s,id:String(s.id)})),...result.stalls]);
    for(const s of result.stalls) expect(validatePlacement(s,ctx,s.id).violations).toEqual([]);
  });
  it('places near a marker',()=>{const result=check(request('4 stalls of 3x3 near FOYER-1G'));expect(result.stalls).toHaveLength(4);expect(result.stalls.every(s=>Math.hypot(s.posX-15,s.posZ-10)<20)).toBe(true);});
  it('asks instead of guessing an unknown marker',()=>{expect(check(request('4 stalls of 3x3 near MISSING')).clarification).toBeTruthy();});
  it('never overlaps walls, restricted zones, passages or existing rotated stalls',()=>{
    const req=request('20 stalls of 3x3');
    req.hall.blockedAreas=[{kind:'wall',posX:0,posZ:0,width:2,length:60,color:'#000'}];
    req.hall.zones=[{id:'p',kind:'PASSAGE',label:'Passage',polygon:[{x:-40,z:-5},{x:40,z:-5},{x:40,z:5},{x:-40,z:5}]}];
    req.existingStalls=[{id:'one',width:6,length:3,posX:-20,posZ:-20,rotation:30,openSides:['FRONT']}];
    expect(check(req).stalls.length).toBeGreaterThan(0);
  });
  it('places in a separate foyer region within the authoritative boundary',()=>{
    const req=request('4 stalls of 3x3 near FOYER-1G');
    req.hall.blockedAreas=[{kind:'wall',posX:0,posZ:0,width:80,length:2,color:'#000'}];
    const result=check(req);expect(result.stalls).toHaveLength(4);expect(result.stalls.every(s=>s.posZ>1)).toBe(true);
  });
  it('never expands an explicit boundary to include a drawn foyer',()=>{
    const req=request('4 stalls of 3x3 near FOYER-1G');
    req.hall.boundary=[{x:-40,z:-30},{x:40,z:-30},{x:40,z:-5},{x:-40,z:-5}];
    req.hall.blockedAreas=[{kind:'wall',posX:0,posZ:0,width:80,length:2,color:'#000'}];
    expect(check(req).stalls).toHaveLength(0);
  });
  it('resolves a foyer label between floor islands to the separate foyer',()=>{
    const req=request('fill the foyer with 3x3 stalls');
    req.hall.blockedAreas=[{kind:'wall',posX:0,posZ:10,width:80,length:2,color:'#000'}];
    req.hall.markers=[{text:'FOYER-1G',position:{x:0,z:10}}];
    const result=check(req);expect(result.stalls.length).toBeGreaterThan(0);expect(result.stalls.every(s=>s.posZ>11)).toBe(true);
  });
  it('supports circle halls without leaving the floor',()=>{const req=request('5 stalls of 3x3');req.hall={...req.hall,shape:'CIRCLE',radius:20,width:0,length:0};expect(check(req).stalls).toHaveLength(5);});
  it('keeps the hall minimum when a valid requested aisle is narrower',()=>{const req=request('3 stalls of 3x3, 1.5 m aisles');expect(check(req).notes.join(' ')).toContain('at least 3 m');});
  it('rejects aisle intents outside the meeting range',()=>{
    for(const width of [1,1.49,5.01,6]) {
      expect(parseSimple(`3 stalls of 3x3, ${width} m aisles`).action).toBe('none');
      expect(()=>validateIntent({...parseSimple('3 stalls of 3x3'),aisleWidth:width})).toThrow();
    }
    const req=request('3 stalls of 3x3, 1.5 m aisles');
    req.hall.rules={minPassageWidth:{B2B:1.5,B2C:1.5}};
    expect(check(req).stalls).toHaveLength(3);
  });
  it('keeps odd-sized halls on the existing edge snap grid',()=>{const req=request('2 stalls of 3x3');req.hall.width=41;const result=check(req);expect(result.stalls).toHaveLength(2);expect(result.stalls.every(s=>Number.isInteger(s.posX-s.width/2+20.5))).toBe(true);});
  it('reports no space rather than breaking placement rules',()=>{const req=request('20 stalls of 3x3');req.hall.width=5;req.hall.length=5;expect(check(req).placedCount).toBe(0);});
  it('removes only the stalls inside the chosen or named zone',()=>{
    const req=request('from exhibition zone delete all the stalls');
    req.hall.planningZones=[{id:'ex',kind:'EXHIBITION',label:'Exhibition',eventType:'B2B',polygon:[{x:-40,z:-30},{x:0,z:-30},{x:0,z:30},{x:-40,z:30}]}];
    req.existingStalls=[{id:'in',name:'Inside',width:3,length:3,posX:-20,posZ:0},{id:'out',name:'Outside',width:3,length:3,posX:20,posZ:0}];
    const intent={...parseSimple('clear all stalls'),area:{type:'whole_hall' as const}};
    expect(planStalls(intent,{...req,zoneId:'ex'}).removals).toEqual([{id:'in',name:'Inside'}]);
    expect(planStalls({...intent,area:{type:'region',marker:'Exhibition zone'}},req).removals).toEqual([{id:'in',name:'Inside'}]);
  });
  it('proposes removals without modifying existing stalls',()=>{const req=request('clear all stalls');req.existingStalls=[{id:'a',name:'Keep until applied',width:3,length:3,posX:0,posZ:0}];const result=check(req);expect(result.stalls).toEqual([]);expect(result.removals).toEqual([{id:'a',name:'Keep until applied'}]);expect(req.existingStalls).toHaveLength(1);});
});

describe('provider isolation',()=>{
  let provider:{configured:jest.Mock;interpret:jest.Mock};
  beforeEach(()=>{provider={configured:jest.fn(()=>true),interpret:jest.fn()};});
  afterEach(()=>{jest.restoreAllMocks();jest.useRealTimers();});
  it('does not call a provider without configuration',async()=>{provider.configured.mockReturnValue(false);const result=await new AssistService(provider as any).assist(request('1 stall of 3x3'));expect(provider.interpret).not.toHaveBeenCalled();expect(result.source).toBe('simple parser');});
  it('retries invalid JSON once',async()=>{provider.interpret.mockRejectedValueOnce(new InvalidIntentError()).mockResolvedValue(parseSimple('1 stall of 3x3'));expect((await new AssistService(provider as any).assist(request())).source).toBe('AI');expect(provider.interpret).toHaveBeenCalledTimes(2);});
  it('falls back after two invalid replies',async()=>{provider.interpret.mockRejectedValue(new InvalidIntentError());expect((await new AssistService(provider as any).assist(request('1 stall of 3x3'))).source).toBe('simple parser');expect(provider.interpret).toHaveBeenCalledTimes(2);});
  it('waits out a short provider rate limit once',async()=>{provider.interpret.mockRejectedValueOnce(new RateLimitedError(10)).mockResolvedValue(parseSimple('1 stall of 3x3'));expect((await new AssistService(provider as any).assist(request())).source).toBe('AI');expect(provider.interpret).toHaveBeenCalledTimes(2);});
  it('falls back at once on a long or unknown rate limit',async()=>{for(const wait of [60000,null]){provider.interpret.mockReset().mockRejectedValue(new RateLimitedError(wait));expect((await new AssistService(provider as any).assist(request('1 stall of 3x3'))).source).toBe('simple parser');expect(provider.interpret).toHaveBeenCalledTimes(1);}});
  it('reads the provider retry-after hint on 429',async()=>{jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:429,headers:new Headers({'retry-after':'2'})} as Response);await expect(new HttpIntentProvider(new ConfigService({AI_API_KEY:'secret'})).interpret(request(),new AbortController().signal)).rejects.toMatchObject({message:'Provider request failed (429).',retryAfterMs:2000});});
  it('times out the whole provider operation at 15 seconds',async()=>{jest.useFakeTimers();provider.interpret.mockImplementation(()=>new Promise(()=>{}));const pending=new AssistService(provider as any).assist(request('1 stall of 3x3'));await jest.advanceTimersByTimeAsync(15000);expect((await pending).source).toBe('simple parser');});
  it.each(['gemini','groq','grok'])('sends only intent requests to %s',async name=>{
    const intent=parseSimple('1 stall of 3x3');const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>name==='gemini'?{candidates:[{content:{parts:[{text:JSON.stringify(intent)}]}}]}:{choices:[{message:{content:JSON.stringify(intent)}}]}} as Response);
    const config=new ConfigService({AI_PROVIDER:name,AI_API_KEY:'test-key'});expect(await new HttpIntentProvider(config).interpret(request(),new AbortController().signal)).toEqual(intent);
    const [url,options]=fetchMock.mock.calls[0];expect(String(url)).not.toContain('test-key');expect(String(options?.body)).not.toContain('test-key');
    if(name==='gemini') expect(JSON.parse(options!.body as string).generationConfig.responseMimeType).toBe('application/json');
  });
  it('does not expose provider errors or keys',async()=>{jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:401} as Response);await expect(new HttpIntentProvider(new ConfigService({AI_API_KEY:'secret'})).interpret(request(),new AbortController().signal)).rejects.toThrow('Provider request failed (401).');});
});
