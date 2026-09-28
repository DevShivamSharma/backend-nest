import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PdfImportModule } from '../src/pdf-import/pdf-import.module';
import { samplePlan } from './fixtures/pdf/cad-pdf';

describe('POST /api/layout/pdf-import', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ imports: [PdfImportModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns the stalls of a CAD plan for review, the L-shape as one outline', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/layout/pdf-import')
      .attach('file', samplePlan(), { filename: 'plan.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(res.body.usedLayers).toBe(true);
    expect(res.body.groups).toEqual([
      expect.objectContaining({ group: '8', pitchX: expect.closeTo(10, 3) }),
    ]);
    const byName = Object.fromEntries(res.body.stalls.map((s: { name: string }) => [s.name, s]));
    expect(byName['08-01 C']).toEqual(
      expect.objectContaining({ shape: 'L-shape', area: 30, include: true }),
    );
    expect(byName['08-01 C'].outline).toHaveLength(6);
    expect(byName['08-01 D']).toEqual(expect.objectContaining({ shape: 'rectangle', area: 12 }));
  });

  it('rejects a missing file, a non-PDF and a bad page number', async () => {
    const server = app.getHttpServer();
    await request(server).post('/api/layout/pdf-import').expect(400);
    const notPdf = await request(server)
      .post('/api/layout/pdf-import')
      .attach('file', Buffer.from('hello'), { filename: 'plan.pdf' })
      .expect(400);
    expect(notPdf.body.message).toBe('The file is not a PDF.');
    await request(server)
      .post('/api/layout/pdf-import?page=0')
      .attach('file', samplePlan(), { filename: 'plan.pdf' })
      .expect(400);
    const missingPage = await request(server)
      .post('/api/layout/pdf-import?page=2')
      .attach('file', samplePlan(), { filename: 'plan.pdf' })
      .expect(400);
    expect(missingPage.body.message).toContain('no page 2');
  });

  it('answers 422 for a PDF that is not a gridded hall plan', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/layout/pdf-import')
      .attach(
        'file',
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
        ),
        { filename: 'blank.pdf' },
      )
      .expect(422);
    expect(res.body.message).toMatch(/stall lines|grid/);
  });

  it('refuses files over the size limit', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(25 * 1024 * 1024 + 10, 32)]);
    await request(app.getHttpServer())
      .post('/api/layout/pdf-import')
      .attach('file', big, { filename: 'big.pdf' })
      .expect(413);
  });
});
