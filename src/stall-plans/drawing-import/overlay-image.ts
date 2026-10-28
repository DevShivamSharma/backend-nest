import { createCanvas } from '@napi-rs/canvas';

import type { PageVectors } from '../cad/pdf-vectors';
import type { ExtractedStall, UnresolvedLabel } from './stall-extraction';

/** The picture sent to the vision model, and how its pixels map back to page points. */
export interface OverlayImage {
  /** JPEG, small enough to be sent inline. */
  jpeg: Buffer;
  width: number;
  height: number;
  /** Page point of the image's top-left corner. */
  originX: number;
  originY: number;
  /** Pixels per page point. */
  scale: number;
}

/** NVIDIA takes an inline image up to 180 KB of base64 (about 135 KB of bytes). */
const MAX_BYTES = 130_000;
const MAX_SIDE = 1400;
const MARGIN = 0.04;

/**
 * The drawing with the stalls the geometry found laid over it, for a model to look at: the
 * drawing's lines in light grey, each stall's outline in blue with its number, and labels without a
 * stall ringed in orange. Cropped to the stalls, so the hall fills the picture.
 */
export function renderOverlay(
  vectors: PageVectors,
  stalls: readonly ExtractedStall[],
  unresolved: readonly UnresolvedLabel[],
): OverlayImage | null {
  const points = [
    ...stalls.flatMap((s) => s.outlinePt.map((p) => [p.x, p.z] as const)),
    ...unresolved.map((u) => [u.x, u.y] as const),
  ];
  if (!points.length) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const padX = (Math.max(...xs) - Math.min(...xs)) * MARGIN + 10;
  const padY = (Math.max(...ys) - Math.min(...ys)) * MARGIN + 10;
  const originX = Math.min(...xs) - padX;
  const originY = Math.min(...ys) - padY;
  const spanX = Math.max(...xs) + padX - originX;
  const spanY = Math.max(...ys) + padY - originY;
  const scale = MAX_SIDE / Math.max(spanX, spanY);
  const width = Math.max(2, Math.round(spanX * scale));
  const height = Math.max(2, Math.round(spanY * scale));

  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  const px = (x: number) => (x - originX) * scale;
  const py = (y: number) => (y - originY) * scale;

  g.strokeStyle = '#b8b8b8';
  g.lineWidth = 1;
  g.beginPath();
  for (const path of vectors.paths) {
    for (const s of path.segments) {
      if (Math.max(s.x1, s.x2) < originX || Math.min(s.x1, s.x2) > originX + spanX) continue;
      if (Math.max(s.y1, s.y2) < originY || Math.min(s.y1, s.y2) > originY + spanY) continue;
      g.moveTo(px(s.x1), py(s.y1));
      g.lineTo(px(s.x2), py(s.y2));
    }
  }
  g.stroke();

  g.strokeStyle = '#1d4ed8';
  g.fillStyle = '#dc2626';
  g.lineWidth = 2;
  g.font = 'bold 12px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  stalls.forEach((s, index) => {
    if (s.outlinePt.length < 3) return;
    g.beginPath();
    s.outlinePt.forEach((p, i) => (i ? g.lineTo(px(p.x), py(p.z)) : g.moveTo(px(p.x), py(p.z))));
    g.closePath();
    g.stroke();
    const cx = s.outlinePt.reduce((a, p) => a + p.x, 0) / s.outlinePt.length;
    const cy = s.outlinePt.reduce((a, p) => a + p.z, 0) / s.outlinePt.length;
    // A number, not the name: a name may carry characters a plain font cannot draw.
    g.fillText(String(index + 1), px(cx), py(cy));
  });
  g.strokeStyle = '#ea580c';
  g.lineWidth = 3;
  for (const u of unresolved) {
    g.beginPath();
    g.arc(px(u.x), py(u.y), 14, 0, Math.PI * 2);
    g.stroke();
  }

  let jpeg = canvas.toBuffer('image/jpeg', 80);
  for (const quality of [65, 50, 38, 28]) {
    if (jpeg.length <= MAX_BYTES) break;
    jpeg = canvas.toBuffer('image/jpeg', quality);
  }
  if (jpeg.length > MAX_BYTES) return null;
  return { jpeg, width, height, originX, originY, scale };
}
