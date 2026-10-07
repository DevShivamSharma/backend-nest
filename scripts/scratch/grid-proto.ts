import sharp from 'sharp';
async function main() {
  const file = process.argv[2];
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * data[3 * i] + 0.587 * data[3 * i + 1] + 0.114 * data[3 * i + 2];
  const L = (x: number, y: number) => lum[y * W + x];
  // thin-line masks: darker than pixels 2 away on both sides
  const V = new Uint8Array(W * H), Hm = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const c = L(x, y);
    if (c > 238) continue;
    if (Math.min(L(x - 2, y), L(x + 2, y)) - c > 18 && Math.max(L(x-2,y),L(x+2,y)) > 200) V[y * W + x] = 1;
    if (Math.min(L(x, y - 2), L(x, y + 2)) - c > 18 && Math.max(L(x,y-2),L(x,y+2)) > 200) Hm[y * W + x] = 1;
  }
  const px = new Float64Array(W), py = new Float64Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { px[x] += V[y * W + x]; py[y] += Hm[y * W + x]; }
  const spec = (prof: Float64Array) => {
    const tot = prof.reduce((a, b) => a + b, 0);
    const out: Array<[number, number, number]> = [];
    for (let p = 4; p <= 60; p += 0.01) {
      let re = 0, im = 0;
      for (let x = 0; x < prof.length; x++) { const a = (2 * Math.PI * x) / p; re += prof[x] * Math.cos(a); im += prof[x] * Math.sin(a); }
      out.push([p, Math.hypot(re, im) / tot, Math.atan2(im, re)]);
    }
    return out;
  };
  const fits: Record<string, { p: number; phase: number }> = {};
  for (const [name, prof] of [['x', px], ['y', py]] as const) {
    const s = spec(prof);
    const max = Math.max(...s.map((e) => e[1]));
    const top = s.filter((e) => e[1] > 0.6 * max);
    const peaks = top.filter((e, i) => { const j = s.indexOf(e); return s[j][1] >= (s[j - 1]?.[1] ?? 0) && s[j][1] >= (s[j + 1]?.[1] ?? 0); });
    const best = peaks[peaks.length - 1];
    fits[name] = { p: best[0], phase: (((best[2] / (2 * Math.PI)) * best[0]) % best[0] + best[0]) % best[0] };
    console.log(name, 'max', max.toFixed(3), peaks.map((e) => `${e[0].toFixed(2)}:${e[1].toFixed(3)}`).join(' '));
  }
  const p = (fits.x.p + fits.y.p) / 2;
  const x0 = fits.x.phase, y0 = fits.y.phase;
  console.log('pitch', p, 'phase', x0, y0);
  const cols = Math.floor((W - x0) / p), rows = Math.floor((H - y0) / p);
  const lineAt = (mask: Uint8Array, vertical: boolean, at: number, from: number, to: number) => {
    let hit = 0, n = 0;
    for (let t = Math.ceil(from + 1); t <= Math.floor(to - 1); t++) {
      n++;
      let ok = 0;
      for (let d = -1; d <= 1; d++) {
        const c = Math.round(at) + d;
        const idx = vertical ? t * W + c : c * W + t;
        if (c >= 0 && (vertical ? c < W : c < H) && mask[idx]) ok = 1;
      }
      hit += ok;
    }
    return n ? hit / n : 0;
  };
  const score = new Float32Array(cols * rows);
  const out = Buffer.from(data);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const xa = x0 + i * p, xb = xa + p, ya = y0 + j * p, yb = ya + p;
    const e = [lineAt(V, true, xa, ya, yb), lineAt(V, true, xb, ya, yb), lineAt(Hm, false, ya, xa, xb), lineAt(Hm, false, yb, xa, xb)];
    const good = e.filter((v) => v >= 0.6).length;
    score[j * cols + i] = good;
    if (good >= 3) for (let y = Math.ceil(ya); y < yb; y++) for (let x = Math.ceil(xa); x < xb; x++) { const k = 3 * (y * W + x); out[k] = out[k] * 0.5; out[k + 1] = Math.min(255, out[k + 1] * 0.5 + 128); out[k + 2] = out[k + 2] * 0.5; }
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(process.argv[3]);
}
main();
