import { pdfImage } from './run-grid';
async function main() {
  const img = await pdfImage(process.argv[2]);
  const [x0, y0, x1, y1] = process.argv[3].split(',').map(Number);
  const W = img.width;
  const lum = (x: number, y: number) => { const k = 3 * (y * W + x); return 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2]; };
  const px = new Float64Array(x1), py = new Float64Array(y1);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const c = lum(x, y);
    if (Math.min(lum(x - 2, y), lum(x + 2, y)) - c > 15) px[x]++;
    if (Math.min(lum(x, y - 2), lum(x, y + 2)) - c > 15) py[y]++;
  }
  for (const [n, prof] of [['x', px], ['y', py]] as const) {
    let best = [0, 0, 0];
    for (let p = 7.5; p <= 8.6; p += 0.005) {
      let re = 0, im = 0, t = 0;
      for (let x = 0; x < prof.length; x++) { re += prof[x] * Math.cos(2 * Math.PI * x / p); im += prof[x] * Math.sin(2 * Math.PI * x / p); t += prof[x]; }
      const s = Math.hypot(re, im) / t;
      if (s > best[1]) best = [p, s, ((Math.atan2(im, re) / (2 * Math.PI) * p) % p + p) % p];
    }
    console.log(n, best.map((v) => v.toFixed(3)).join(' '));
  }
}
main();
