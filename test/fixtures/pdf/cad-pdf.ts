/**
 * Builds small CAD-style PDFs for tests: stroked lines on named optional-content layers (the
 * way AutoCAD exports layers) and text, in page points with y DOWN (as the drawing is viewed).
 */
export interface CadLine {
  layer: string;
  rgb: [number, number, number];
  width: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CadText {
  text: string;
  x: number;
  y: number;
  size?: number;
}

export function cadPdf(
  lines: CadLine[],
  texts: CadText[],
  size = { width: 800, height: 600 },
): Buffer {
  const layers = [...new Set(lines.map((l) => l.layer).filter(Boolean))];
  const ocRef = (i: number) => 5 + i;
  const fontRef = 5 + layers.length;
  const Y = (y: number) => size.height - y;
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops: string[] = [];
  for (const l of lines) {
    const k = layers.indexOf(l.layer);
    if (k >= 0) ops.push(`/OC /L${k} BDC`);
    ops.push(
      `${l.rgb.map((v) => (v / 255).toFixed(4)).join(' ')} RG ${l.width} w ${l.x1} ${Y(l.y1)} m ${l.x2} ${Y(l.y2)} l S`,
    );
    if (k >= 0) ops.push('EMC');
  }
  for (const t of texts) {
    const s = t.size ?? 6;
    // Centre the span roughly on (x, y): Helvetica caps are ~0.6 em wide.
    ops.push(
      `BT /F1 ${s} Tf ${t.x - t.text.length * s * 0.3} ${Y(t.y) - s * 0.35} Td (${esc(t.text)}) Tj ET`,
    );
  }
  const content = ops.join('\n');
  const props = layers.map((_, i) => `/L${i} ${ocRef(i)} 0 R`).join(' ');
  const ocgs = layers.map((_, i) => `${ocRef(i)} 0 R`).join(' ');
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${ocgs}] /D << /ON [${ocgs}] >> >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Contents 4 0 R ` +
      `/Resources << /Properties << ${props} >> /Font << /F1 ${fontRef} 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...layers.map((name) => `<< /Type /OCG /Name (${esc(name)}) >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A hall plan at 10 pt per metre: a 30 x 20 m grid, one L-shaped stall and one rectangle. */
export function samplePlan(): Buffer {
  const M = 10;
  const O = 100;
  const p = (m: number) => O + m * M;
  const lines: CadLine[] = [];
  const line = (
    layer: string,
    rgb: CadLine['rgb'],
    width: number,
    a: number,
    b: number,
    c: number,
    d: number,
  ) => lines.push({ layer, rgb, width, x1: p(a), y1: p(b), x2: p(c), y2: p(d) });
  for (let x = 0; x <= 30; x++) line('GRID', [173, 173, 173], 0.3, x, 0, x, 20);
  for (let y = 0; y <= 20; y++) line('GRID', [173, 173, 173], 0.3, 0, y, 30, y);
  const red: CadLine['rgb'] = [255, 0, 0];
  const magenta: CadLine['rgb'] = [255, 0, 255];
  // L-shaped stall C (30 m²): partitions on top and right, fascia along the rest.
  line('PARTITION', red, 1.44, 2, 2, 9, 2);
  line('PARTITION', red, 1.44, 9, 2, 9, 8);
  for (const [a, b, c, d] of [
    [9, 8, 6, 8],
    [6, 8, 6, 5],
    [6, 5, 2, 5],
    [2, 5, 2, 2],
  ])
    line('FACIA', magenta, 1.08, a, b, c, d);
  // Rectangle D (12 m²).
  line('PARTITION', red, 1.44, 9, 2, 12, 2);
  line('PARTITION', red, 1.44, 12, 2, 12, 6);
  line('FACIA', magenta, 1.08, 12, 6, 9, 6);
  const texts: CadText[] = [
    { text: 'C', x: p(3), y: p(3) },
    { text: '30m2', x: p(5), y: p(4) },
    { text: 'D', x: p(10.5), y: p(3.5) },
    { text: '08-01', x: p(11), y: p(9) },
  ];
  return cadPdf(lines, texts);
}
