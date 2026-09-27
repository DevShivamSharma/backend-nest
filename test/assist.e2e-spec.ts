import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AssistModule } from '../src/layouts/assist/assist.module';
import { HttpIntentProvider } from '../src/layouts/assist/intent-provider';

describe('Layout assistant HTTP',()=>{
  let app:INestApplication;
  const body={requirement:'3 stalls of 3x3',hall:{id:1,name:'Hall',shape:'SQUARE',width:40,length:40,rules:{}},existingStalls:[]};
  beforeEach(async()=>{const module=await Test.createTestingModule({imports:[AssistModule]}).overrideProvider(HttpIntentProvider).useValue({configured:()=>false}).compile();app=module.createNestApplication();app.setGlobalPrefix('api');app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();});
  afterEach(async()=>{await app.close();});
  it('matches the existing frontend contract with no key',async()=>{const res=await request(app.getHttpServer()).post('/api/layout/assist').send(body).expect(200);expect(res.body.stalls).toHaveLength(3);expect(res.body.notes.join(' ')).toContain('simple parser');expect(res.body.summary).toBeTruthy();});
  it('rejects oversized requirements',async()=>{await request(app.getHttpServer()).post('/api/layout/assist').send({...body,requirement:'x'.repeat(501)}).expect(400);});
  it('rate limits only the assistant endpoint',async()=>{for(let i=0;i<10;i++)await request(app.getHttpServer()).post('/api/layout/assist').send({...body,requirement:'hello'}).expect(200);await request(app.getHttpServer()).post('/api/layout/assist').send(body).expect(429);});
});
