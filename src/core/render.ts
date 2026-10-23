// Draws a page into a PNG for the transcription model, with no canvas and no DOM: it runs in the app (JavaScript only),
// also in the background. Same layout as the Obsidian plugin's renderStrokesPng (render/png.ts): same size, scale and
// stroke width, so what the model sees is the same. Only the plain black-on-white case: all strokes new (black).

import { deflate } from "pako";
import { Stroke } from "./models";

export interface PngResult {
  /** The PNG file. */
  bytes: Uint8Array;
  width: number;
  height: number;
  /** From image pixels to Ncode units: x = px / scale + ox. */
  ox: number;
  oy: number;
  scale: number;
}

const TARGET_PIXELS = 1_150_000;
const MAX_SIDE = 1800;
const MAX_SCALE = 24;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
  return out;
}

/** 8-bit grayscale PNG (smaller than RGB: the writing is black on white). */
export function encodeGrayPng(gray: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Points of the smooth curve (quadratic through the midpoints, like the plugin's canvas path), in pixels. */
function flatten(p: number[], X: (v: number) => number, Y: (v: number) => number): number[] {
  const n = p.length / 3;
  const out: number[] = [X(p[0]), Y(p[1])];
  if (n === 1) {
    out.push(X(p[0]) + 0.5, Y(p[1]));
    return out;
  }
  let cx = X(p[0]),
    cy = Y(p[1]);
  for (let i = 1; i < n - 1; i++) {
    const qx = X(p[i * 3]),
      qy = Y(p[i * 3 + 1]);
    const ex = X((p[i * 3] + p[(i + 1) * 3]) / 2),
      ey = Y((p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2);
    const steps = Math.max(1, Math.min(6, Math.ceil(Math.hypot(ex - cx, ey - cy) / 3)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps,
        u = 1 - t;
      out.push(u * u * cx + 2 * u * t * qx + t * t * ex, u * u * cy + 2 * u * t * qy + t * t * ey);
    }
    cx = ex;
    cy = ey;
  }
  out.push(X(p[(n - 1) * 3]), Y(p[(n - 1) * 3 + 1]));
  return out;
}

/**
 * Draws all the ink strokes in black on white. Returns null if there is nothing to draw.
 * `maxForce` is the pen's maximum pressure (it sets the line width, as in the plugin).
 */
export function renderPagePng(strokes: Stroke[], maxForce = 1023, targetPixels = TARGET_PIXELS): PngResult | null {
  const visible = strokes.filter((s) => s.tip !== 1 && s.pts.length >= 3);
  if (!visible.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const s of visible)
    for (let i = 0; i < s.pts.length; i += 3) {
      minX = Math.min(minX, s.pts[i]);
      maxX = Math.max(maxX, s.pts[i]);
      minY = Math.min(minY, s.pts[i + 1]);
      maxY = Math.max(maxY, s.pts[i + 1]);
    }
  const pad = 1.5;
  const wU = maxX - minX + pad * 2;
  const hU = maxY - minY + pad * 2;
  const scale = Math.min(MAX_SCALE, Math.sqrt(targetPixels / (wU * hU)), MAX_SIDE / Math.max(wU, hU));
  const W = Math.max(64, Math.round(wU * scale));
  const H = Math.max(64, Math.round(hU * scale));
  const ox = minX - pad;
  const oy = minY - pad;
  const X = (v: number) => (v - ox) * scale;
  const Y = (v: number) => (v - oy) * scale;

  const gray = new Uint8Array(W * H).fill(255);
  for (const s of visible) {
    const p = s.pts;
    const n = p.length / 3;
    let sum = 0;
    for (let i = 2; i < p.length; i += 3) sum += p[i];
    const avg = sum / n / (maxForce || 1023);
    const lineWidth = Math.max(2, 0.19 * scale * (0.75 + 0.5 * Math.min(1, avg)));
    const r = lineWidth / 2;
    const pts = flatten(p, X, Y);
    // coverage of this stroke only (one stroke never darkens itself twice)
    let bx0 = Infinity,
      bx1 = -Infinity,
      by0 = Infinity,
      by1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      bx0 = Math.min(bx0, pts[i]);
      bx1 = Math.max(bx1, pts[i]);
      by0 = Math.min(by0, pts[i + 1]);
      by1 = Math.max(by1, pts[i + 1]);
    }
    const x0 = Math.max(0, Math.floor(bx0 - r - 1)),
      x1 = Math.min(W - 1, Math.ceil(bx1 + r + 1)),
      y0 = Math.max(0, Math.floor(by0 - r - 1)),
      y1 = Math.min(H - 1, Math.ceil(by1 + r + 1));
    if (x1 < x0 || y1 < y0) continue;
    const bw = x1 - x0 + 1;
    const cover = new Uint8Array(bw * (y1 - y0 + 1));
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i],
        ay = pts[i + 1],
        bx = pts[i + 2],
        by = pts[i + 3];
      const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - r - 1)),
        sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + r + 1)),
        sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - r - 1)),
        sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + r + 1));
      const dx = bx - ax,
        dy = by - ay;
      const len2 = dx * dx + dy * dy;
      for (let y = sy0; y <= sy1; y++) {
        const row = (y - y0) * bw - x0;
        for (let x = sx0; x <= sx1; x++) {
          const px = x + 0.5 - ax,
            py = y + 0.5 - ay;
          const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
          const d = Math.hypot(px - t * dx, py - t * dy);
          const c = Math.max(0, Math.min(1, r + 0.5 - d));
          if (c > 0) {
            const v = Math.round(c * 255);
            if (v > cover[row + x]) cover[row + x] = v;
          }
        }
      }
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const c = cover[(y - y0) * bw + (x - x0)];
        if (c) gray[y * W + x] = Math.round((gray[y * W + x] * (255 - c)) / 255);
      }
  }
  return { bytes: encodeGrayPng(gray, W, H), width: W, height: H, ox, oy, scale };
}
