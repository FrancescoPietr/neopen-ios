// Una tela 2D fatta solo in JavaScript, per il telefono (niente browser): le operazioni che usa render/png.ts
// (sfondo, tratti con curve morbide e punte rotonde, cerchietti pieni, numeri) con i bordi sfumati, e il PNG.
// Ogni tratto copre un pixel una volta sola (come un percorso del <canvas>): non si scurisce dove passa due volte.

import { zlibSync } from "fflate";

type RGB = [number, number, number];

function color(css: string): RGB {
  const h = String(css).trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const v = parseInt(full, 16);
  return Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : [0, 0, 0];
}

// cifre 5×7 (per i numeri delle frecce di risposta)
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

class Context2D {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  private paths: number[][] = [];
  private discs: { x: number; y: number; r: number }[] = [];
  private cx = 0;
  private cy = 0;

  constructor(private c: SoftCanvas) {}

  private blend(i: number, rgb: RGB, a: number): void {
    const d = this.c.data;
    const k = i * 3;
    d[k] = d[k] + (rgb[0] - d[k]) * a;
    d[k + 1] = d[k + 1] + (rgb[1] - d[k + 1]) * a;
    d[k + 2] = d[k + 2] + (rgb[2] - d[k + 2]) * a;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const rgb = color(this.fillStyle);
    const W = this.c.width;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.c.height, Math.ceil(y + h)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(W, Math.ceil(x + w)); xx++) this.blend(yy * W + xx, rgb, 1);
  }

  beginPath(): void {
    this.paths = [];
    this.discs = [];
  }

  moveTo(x: number, y: number): void {
    this.paths.push([x, y]);
    this.cx = x;
    this.cy = y;
  }

  lineTo(x: number, y: number): void {
    if (!this.paths.length) this.paths.push([this.cx, this.cy]);
    this.paths[this.paths.length - 1].push(x, y);
    this.cx = x;
    this.cy = y;
  }

  quadraticCurveTo(qx: number, qy: number, x: number, y: number): void {
    if (!this.paths.length) this.paths.push([this.cx, this.cy]);
    const path = this.paths[this.paths.length - 1];
    const sx = this.cx,
      sy = this.cy;
    const steps = Math.max(1, Math.min(8, Math.ceil(Math.hypot(x - sx, y - sy) / 3)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps,
        u = 1 - t;
      path.push(u * u * sx + 2 * u * t * qx + t * t * x, u * u * sy + 2 * u * t * qy + t * t * y);
    }
    this.cx = x;
    this.cy = y;
  }

  arc(x: number, y: number, r: number): void {
    // usato solo per cerchi pieni (i numeri delle frecce)
    this.discs.push({ x, y, r });
  }

  closePath(): void {}

  /** Tutti i pezzi del percorso insieme: ogni pixel prende la copertura più alta (niente doppi passaggi). */
  stroke(): void {
    const rgb = color(this.strokeStyle);
    const r = Math.max(0.5, this.lineWidth / 2);
    const W = this.c.width,
      H = this.c.height;
    let bx0 = Infinity,
      bx1 = -Infinity,
      by0 = Infinity,
      by1 = -Infinity;
    for (const p of this.paths)
      for (let i = 0; i < p.length; i += 2) {
        bx0 = Math.min(bx0, p[i]);
        bx1 = Math.max(bx1, p[i]);
        by0 = Math.min(by0, p[i + 1]);
        by1 = Math.max(by1, p[i + 1]);
      }
    const x0 = Math.max(0, Math.floor(bx0 - r - 1)),
      x1 = Math.min(W - 1, Math.ceil(bx1 + r + 1)),
      y0 = Math.max(0, Math.floor(by0 - r - 1)),
      y1 = Math.min(H - 1, Math.ceil(by1 + r + 1));
    if (x1 < x0 || y1 < y0) return;
    const bw = x1 - x0 + 1;
    const cover = new Float32Array(bw * (y1 - y0 + 1));
    for (const p of this.paths) {
      const pts = p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i],
          ay = pts[i + 1],
          ex = pts[i + 2],
          ey = pts[i + 3];
        const sx0 = Math.max(x0, Math.floor(Math.min(ax, ex) - r - 1)),
          sx1 = Math.min(x1, Math.ceil(Math.max(ax, ex) + r + 1)),
          sy0 = Math.max(y0, Math.floor(Math.min(ay, ey) - r - 1)),
          sy1 = Math.min(y1, Math.ceil(Math.max(ay, ey) + r + 1));
        const dx = ex - ax,
          dy = ey - ay;
        const len2 = dx * dx + dy * dy;
        for (let y = sy0; y <= sy1; y++) {
          const py = y + 0.5;
          const row = (y - y0) * bw - x0;
          for (let x = sx0; x <= sx1; x++) {
            const px = x + 0.5;
            let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + t * dx - px,
              qy = ay + t * dy - py;
            const a = r + 0.5 - Math.sqrt(qx * qx + qy * qy);
            if (a <= 0) continue;
            const v = a > 1 ? 1 : a;
            if (v > cover[row + x]) cover[row + x] = v;
          }
        }
      }
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const a = cover[(y - y0) * bw + (x - x0)];
        if (a > 0) this.blend(y * W + x, rgb, a);
      }
  }

  fill(): void {
    const rgb = color(this.fillStyle);
    const W = this.c.width,
      H = this.c.height;
    for (const d of this.discs) {
      for (let y = Math.max(0, Math.floor(d.y - d.r - 1)); y <= Math.min(H - 1, Math.ceil(d.y + d.r + 1)); y++)
        for (let x = Math.max(0, Math.floor(d.x - d.r - 1)); x <= Math.min(W - 1, Math.ceil(d.x + d.r + 1)); x++) {
          const a = d.r + 0.5 - Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y);
          if (a > 0) this.blend(y * W + x, rgb, a > 1 ? 1 : a);
        }
    }
  }

  /** Solo cifre (i numeri delle frecce), centrate sul punto. */
  fillText(text: string, x: number, y: number): void {
    const rgb = color(this.fillStyle);
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
    const cell = Math.max(1, size / 7);
    const chars = String(text).split("").filter((ch) => DIGITS[ch]);
    const w = chars.length * 6 * cell - cell;
    let left = this.textAlign === "center" ? x - w / 2 : this.textAlign === "right" || this.textAlign === "end" ? x - w : x;
    const top = this.textBaseline === "middle" ? y - 3.5 * cell : this.textBaseline === "top" ? y : y - 7 * cell;
    const W = this.c.width,
      H = this.c.height;
    for (const ch of chars) {
      DIGITS[ch].forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] !== "1") continue;
          for (let yy = Math.floor(top + ry * cell); yy < Math.ceil(top + (ry + 1) * cell); yy++)
            for (let xx = Math.floor(left + rx * cell); xx < Math.ceil(left + (rx + 1) * cell); xx++)
              if (xx >= 0 && yy >= 0 && xx < W && yy < H) this.blend(yy * W + xx, rgb, 1);
        }
      });
      left += 6 * cell;
    }
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class SoftCanvas {
  readonly data: Uint8Array;
  private ctx: Context2D;

  constructor(public width: number, public height: number) {
    this.data = new Uint8Array(width * height * 3).fill(255);
    this.ctx = new Context2D(this);
  }

  getContext(): Context2D {
    return this.ctx;
  }

  /** Il PNG (RGB, 8 bit). */
  png(): Uint8Array {
    const W = this.width,
      H = this.height;
    const raw = new Uint8Array((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W * 3 + 1)] = 0;
      raw.set(this.data.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W);
    dv.setUint32(4, H);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  toDataURL(): string {
    return `data:image/png;base64,${toBase64(this.png())}`;
  }
}
