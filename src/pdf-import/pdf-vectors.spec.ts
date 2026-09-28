import { PdfReadError, readPageVectors } from './pdf-vectors';

/**
 * A minimal CAD-style PDF built in the test: one landscape page rotated 90°, a red line on the
 * optional-content layer "PARTITION", a grey line on no layer, and one text span.
 */
function tinyPdf(): Uint8Array {
  const content = [
    '/OC /L1 BDC',
    '1 0 0 RG 1.44 w 100 100 m 200 100 l S',
    'EMC',
    '0.5 0.5 0.5 RG 0.5 w 100 50 m 100 150 l S',
    'BT /F1 8 Tf 120 120 Td (11-13) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /ON [5 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Rotate 90 /Contents 4 0 R ' +
      '/Resources << /Properties << /L1 5 0 R >> /Font << /F1 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /OCG /Name (PARTITION) >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('readPageVectors', () => {
  it('reads lines with their layer, colour and width, in displayed (rotated) page points', async () => {
    const v = await readPageVectors(tinyPdf());
    expect(v.pageCount).toBe(1);
    expect(v.rotation).toBe(90);
    // Rotated 90°: the displayed page is 300 wide, 400 tall.
    expect([v.width, v.height]).toEqual([300, 400]);
    expect(v.layers).toEqual(['PARTITION']);

    const red = v.paths.find((p) => p.layer === 'PARTITION')!;
    expect(red.stroke).toBe('#ff0000');
    expect(red.width).toBeCloseTo(1.44, 6);
    // PDF (x, y) -> displayed (y, x) for a 90° rotation: the horizontal line becomes vertical.
    const s = red.segments[0];
    expect(s.x1).toBeCloseTo(100, 6);
    expect(s.x2).toBeCloseTo(100, 6);
    expect(Math.abs(s.y2 - s.y1)).toBeCloseTo(100, 6);

    const grey = v.paths.find((p) => p.layer === '')!;
    expect(grey.stroke).toBe('#808080');
  });

  it('reads text spans', async () => {
    const v = await readPageVectors(tinyPdf());
    expect(v.texts.map((t) => t.text)).toEqual(['11-13']);
    expect(v.texts[0].size).toBeCloseTo(8, 6);
  });

  it('rejects data that is not a PDF', async () => {
    await expect(readPageVectors(new TextEncoder().encode('hello'))).rejects.toBeInstanceOf(PdfReadError);
  });
});
