// Lattice fitting reused from origin/main f4ed0de; input is PDF point coordinates.
export function globalPitch(vs: number[], hs: number[]): number | null {
  const diffs: number[] = [];
  for (const arr of [vs, hs]) {
    const s = [...new Set(arr.map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      const d = s[i] - s[i - 1];
      if (d > 1 && d < 60) diffs.push(d);
    }
  }
  if (diffs.length < 5) return null;
  // Histogram at 0.25 pt, then the mean of the diffs within ±4 % of the busiest bin.
  const bins = new Map<number, number>();
  for (const d of diffs) bins.set(Math.round(d * 4), (bins.get(Math.round(d * 4)) ?? 0) + 1);
  const [peak] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
  const centre = peak / 4;
  const near = diffs.filter((d) => Math.abs(d - centre) <= centre * 0.04);
  return near.reduce((s, d) => s + d, 0) / near.length;
}

export function fitLattice(
  values: number[],
  guess: number,
): { pitch: number; origin: number; rms: number; used: number } {
  const vals = [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  if (vals.length < 3) return { pitch: guess, origin: vals[0] ?? 0, rms: 0, used: vals.length };
  let best = { pitch: guess, origin: vals[0], rms: Infinity, used: 0 };
  for (let step = -300; step <= 300; step++) {
    const p = guess * (1 + step * 0.0001);
    const base = vals[Math.floor(vals.length / 2)];
    // Circular mean of the phases gives the origin for this pitch.
    let sx = 0;
    let sy = 0;
    for (const v of vals) {
      const t = (2 * Math.PI * (v - base)) / p;
      sx += Math.cos(t);
      sy += Math.sin(t);
    }
    const origin = base + (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
    const res = vals.map((v) => v - (origin + Math.round((v - origin) / p) * p));
    const inl = res.filter((r) => Math.abs(r) <= 0.2 * p);
    if (inl.length < vals.length * 0.6) continue;
    const rms = Math.sqrt(inl.reduce((s, r) => s + r * r, 0) / inl.length);
    // Prefer more lines on the lattice, then the lower residual.
    if (inl.length > best.used || (inl.length === best.used && rms < best.rms))
      best = { pitch: p, origin, rms, used: inl.length };
  }
  return best.rms === Infinity ? { pitch: guess, origin: vals[0], rms: 0, used: 0 } : best;
}
