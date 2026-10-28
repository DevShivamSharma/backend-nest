import { readFileSync } from 'fs';
import { join } from 'path';

import { readPageVectors } from '../cad/pdf-vectors';
import { runDrawingJob } from './drawing-import.job';
import { extractStalls, stallLayerModes } from './stall-extraction';

const pdf = join(__dirname, '../../../test/fixtures/floor-plan/8-9-10.pdf');

describe('reading a plan PDF through DXF', () => {
  jest.setTimeout(180_000);

  it('should find the same stalls from the converted DXF as the PDF holds, and read an uploaded DXF', async () => {
    const data = new Uint8Array(readFileSync(pdf));
    const stalls = await runDrawingJob({ kind: 'stalls', data, page: 1 });
    if (!stalls.ok) throw new Error(stalls.kind + ': ' + stalls.message);
    if (!stalls.ok || stalls.kind !== 'stalls') return;
    const direct = extractStalls(await readPageVectors(data, 1, { layerMode: stallLayerModes }));
    // eslint-disable-next-line no-console
    console.log('direct', direct.stalls.length, 'via dxf', stalls.result.stalls.length);
    expect(stalls.result.stalls.length).toBe(direct.stalls.length);

    const dxf = await runDrawingJob({ kind: 'dxf', data, page: 1 });
    if (!dxf.ok || dxf.kind !== 'dxf') throw new Error('no dxf');
    expect(dxf.dxf).toContain('ENTITIES');

    const again = await runDrawingJob({
      kind: 'stalls',
      data: new Uint8Array(Buffer.from(dxf.dxf)),
      page: 1,
    });
    // The metre-scaled DXF is read as it is: same stalls, found from the drawing alone.
    expect(again.ok).toBe(true);
    if (again.ok && again.kind === 'stalls') {
      expect(again.result.stalls.length).toBe(stalls.result.stalls.length);
    }
  });
});
