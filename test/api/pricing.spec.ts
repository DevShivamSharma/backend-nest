import '../setup-env';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';

const masters:number[] = [], layouts:number[]=[];
const name=()=>`Pricing test ${Date.now()} ${Math.random().toString(36).slice(2,8)}`;
const policy=()=>({name:name(),bare_rate:100,shell_rate:150,tax_mode:'IGST',igst_percent:18,
  two_side_open_rate_percent:10,emc_markup_percent:5,emc_fixed_charge:25,emc_taxable:true});
const data={layoutName:'Pricing test layout',hall:{name:'Pricing test hall',shape:'SQUARE',width:40,length:40,rules:{}},
  stalls:[{name:'Test stall',width:6,length:6,height:3,posX:0,posZ:0,openSides:['FRONT','LEFT']}]};
test.afterEach(async({request})=>{
  for(const id of layouts.splice(0)) expect((await request.delete('/api/layout/'+id)).ok()).toBe(true);
  if(masters.length) {
    const db=new Client({ host:process.env.DATABASE_HOST, port:Number(process.env.DATABASE_PORT ?? 5432),
      user:process.env.DATABASE_USER, password:process.env.DATABASE_PASSWORD, database:'stall_designer_test' });
    await db.connect();
    try { await db.query('DELETE FROM price_masters WHERE id = ANY($1::bigint[])',[masters.splice(0)]); }
    finally { await db.end(); }
  }
});
async function createMaster(request: APIRequestContext, input=policy()) {
  const response=await request.post('/api/price-masters',{data:input});expect(response.status(),await response.text()).toBe(201);
  const master=await response.json();masters.push(master.id);return master;
}
async function fixture(request: APIRequestContext) {
  const master=await createMaster(request);
  const response=await request.post('/api/layout/save',{data});expect(response.status()).toBe(201);
  const saved=await response.json(),id=saved.layout.id;layouts.push(id);
  const apply=await request.put(`/api/layout/${id}/pricing`,{data:{masterId:master.id,revision:1}});expect(apply.status(),await apply.text()).toBe(200);
  return {id,master,saved,number:saved.stalls[0].stallNumber};
}
async function publish(request:APIRequestContext,id:number,stalls:unknown[]) {
  const response=await request.post(`/api/layout/${id}/publish`,{data:{...data,stalls}});
  expect(response.status(),await response.text()).toBe(200);return response.json();
}
test('persistent masters use optimistic revision checks and imports are atomic',async({request})=>{
  const master=await createMaster(request);
  const update=await request.put(`/api/price-masters/${master.id}`,{data:{revision:1,master:{...master.policy,name:master.name,bare_rate:200}}});
  expect(update.status()).toBe(200);expect((await update.json()).revision).toBe(2);
  expect((await request.put(`/api/price-masters/${master.id}`,{data:{revision:1,master:policy()}})).status()).toBe(409);
  const fresh=policy();
  expect((await request.post('/api/price-masters/import',{data:{rows:[fresh,{...policy(),bare_rate:-2}]}})).status()).toBe(400);
  expect((await request.post('/api/price-masters/import',{data:{rows:[fresh,{...policy(),name:master.name.toUpperCase()}]}})).status()).toBe(409);
  expect((await (await request.get('/api/price-masters')).json()).some((m:any)=>m.name===fresh.name)).toBe(false);
  const imported=await request.post('/api/price-masters/import',{data:{rows:[fresh,policy()]}});expect(imported.status()).toBe(201);
  const rows=await imported.json();masters.push(...rows.map((m:any)=>m.id));expect(rows).toHaveLength(2);
});
test('applied snapshot is stable across master edits; explicit apply returns layout to draft',async({request})=>{
  const {id,master,saved,number}=await fixture(request);
  await publish(request,id,saved.stalls);
  const original=await(await request.get(`/api/layout/${id}/stalls/${number}/quote?stallType=bare`)).json();
  expect((await request.put(`/api/price-masters/${master.id}`,{data:{revision:1,master:{name:master.name,...master.policy,bare_rate:200}}})).status()).toBe(200);
  expect(await(await request.get(`/api/layout/${id}/stalls/${number}/quote?stallType=bare`)).json()).toEqual(original);
  expect((await request.put(`/api/layout/${id}/pricing`,{data:{masterId:master.id,revision:1}})).status()).toBe(409);
  expect((await request.put(`/api/layout/${id}/pricing`,{data:{masterId:master.id,revision:2}})).status()).toBe(200);
  const detail=await(await request.get(`/api/layout/${id}`)).json();expect(detail.layout.status).toBe('DRAFT');expect(detail.layout.pricingPolicy.revision).toBe(2);
});
test('the advertised 500-row import fits the HTTP body limit and 501 rows are rejected',async({request})=>{
  const prefix=name();
  const rows=Array.from({length:500},(_,i)=>({...policy(),name:prefix+' '+i,emc_name:'Test EMC',
    shell_rate:150,three_side_open_rate_percent:15,four_side_open_rate_percent:20,
    catlog_entry_charge:50,cgst_percent:0,sgst_percent:0}));
  expect(Buffer.byteLength(JSON.stringify({rows}))).toBeGreaterThan(100*1024);
  const response=await request.post('/api/price-masters/import',{data:{rows}});expect(response.status(),await response.text()).toBe(201);
  const imported=await response.json();masters.push(...imported.map((m:any)=>m.id));expect(imported).toHaveLength(500);
  expect((await request.post('/api/price-masters/import',{data:{rows:[...rows,policy()]}})).status()).toBe(400);
});
test('priced booking requires publication and reviewed quote; rejects caller prices and duplicate bookings',async({request})=>{
  const {id,saved,number}=await fixture(request);
  const url=`/api/layout/${id}/stalls/${number}`;
  const quote=await(await request.get(url+'/quote?stallType=bare')).json();expect(quote.total).toBe(4935.94);
  const body={stall_type:'bare',expectedQuote:quote.fingerprint};
  expect((await request.post(url+'/book',{data:body})).status()).toBe(409);
  await publish(request,id,saved.stalls);
  expect((await request.post(url+'/book',{data:{stall_type:'bare'}})).status()).toBe(409);
  expect((await request.post(url+'/book',{data:{...body,tax:{igst_percent:0}}})).status()).toBe(400);
  const both=await Promise.all([request.post(url+'/book',{data:body}),request.post(url+'/book',{data:body})]);
  expect(both.map(r=>r.status()).sort()).toEqual([200,409]);
  const booking=await both.find(r=>r.status()===200)!.json();expect(booking.quote).toEqual(quote);
  expect(booking.selfcare.T_STALL_BOOKING_DETAIL[0].net_payable_amount).toBe(4672.8);
  expect(booking.selfcare.T_STALL_BOOKING.payment_status).toBe('Pending');
});
test('receipt survives save and a stale editor cannot erase a priced booking',async({request})=>{
  const {id,saved,number}=await fixture(request);await publish(request,id,saved.stalls);
  const url=`/api/layout/${id}/stalls/${number}`, quote=await(await request.get(url+'/quote?stallType=bare')).json();
  expect((await request.post(url+'/book',{data:{stall_type:'bare',expectedQuote:quote.fingerprint}})).status()).toBe(200);
  expect((await request.put(`/api/layout/${id}`,{data:{...data,stalls:saved.stalls}})).status()).toBe(409);
  const detail=await(await request.get(`/api/layout/${id}`)).json();
  const update=await request.put(`/api/layout/${id}`,{data:{...data,stalls:detail.stalls}});expect(update.status(),await update.text()).toBe(200);
  expect(await(await request.get(url+'/quote?stallType=shell')).json()).toEqual(quote);
  const changed=detail.stalls.map((s:any)=>({...s,width:7}));
  expect((await request.put(`/api/layout/${id}`,{data:{...data,stalls:changed}})).status()).toBe(409);
});
test('a changed rate snapshot invalidates the old quote even after republishing',async({request})=>{
  const {id,master,saved,number}=await fixture(request);await publish(request,id,saved.stalls);
  const url=`/api/layout/${id}/stalls/${number}`,quote=await(await request.get(url+'/quote?stallType=bare')).json();
  await request.put(`/api/price-masters/${master.id}`,{data:{revision:1,master:{name:master.name,...master.policy,emc_fixed_charge:99}}});
  await request.put(`/api/layout/${id}/pricing`,{data:{masterId:master.id,revision:2}});await publish(request,id,saved.stalls);
  expect((await request.post(url+'/book',{data:{stall_type:'bare',expectedQuote:quote.fingerprint}})).status()).toBe(409);
  expect((await(await request.get(`/api/layout/${id}`)).json()).stalls[0].status).toBe('AVAILABLE');
});
