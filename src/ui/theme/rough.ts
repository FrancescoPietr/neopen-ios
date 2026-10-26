// Hand-drawn geometry: lines, boxes, circles and icons that look traced with a pen (a little wavy, never perfectly
// straight, the ends slightly past the corners). Everything is seeded: the same element always wobbles the same way,
// so nothing moves between renders. Plain TypeScript (tested in Node), SVG path strings out.

export type Pt = [number, number];
export type Stroke = Pt[];

/** Deterministic random numbers from a string. */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** Smooth path through the points (Catmull-Rom → cubic Bézier). */
export function smooth(pts: Pt[], closed = false): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
  const p = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${f(p[1][0])} ${f(p[1][1])}`;
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Points every `step` along a polyline. */
export function resample(stroke: Stroke, step: number): Stroke {
  if (stroke.length < 2) return stroke.slice();
  const out: Stroke = [stroke[0]];
  let carry = 0;
  for (let i = 1; i < stroke.length; i++) {
    const [x0, y0] = stroke[i - 1];
    const [x1, y1] = stroke[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let at = step - carry;
    while (at < len) {
      out.push([x0 + ((x1 - x0) * at) / len, y0 + ((y1 - y0) * at) / len]);
      at += step;
    }
    carry = len - (at - step);
  }
  const last = stroke[stroke.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * The stroke as drawn by hand: points moved a little sideways with a slow wave (not random noise: a hand drifts, it
 * doesn't shake). `amp` = how far it drifts.
 */
export function wobble(stroke: Stroke, seed: string, amp: number, step = 6): Stroke {
  const r = rng(seed);
  const pts = resample(stroke, step);
  const phase = r() * Math.PI * 2;
  const freq = 0.5 + r() * 0.8;
  const drift = (r() - 0.5) * 2;
  return pts.map(([x, y], i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const t = i / Math.max(1, pts.length - 1);
    const off = amp * (Math.sin(phase + t * Math.PI * freq * 2) * 0.7 + drift * 0.3 * Math.sin(t * Math.PI) + (r() - 0.5) * 0.25);
    return [x + nx * off, y + ny * off];
  });
}

/** A straight line drawn by hand (a little bowed, the ends a touch past the points). */
export function roughLine(x1: number, y1: number, x2: number, y2: number, seed: string, amp = 1.2): string {
  const r = rng(seed + "e");
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const over = (r() - 0.3) * 2;
  const a: Pt = [x1 - ux * over, y1 - uy * over];
  const b: Pt = [x2 + ux * (r() - 0.3) * 2, y2 + uy * (r() - 0.3) * 2];
  return smooth(wobble([a, b], seed, amp, Math.max(8, len / 12)));
}

/** Your own drawn line stretched between two points (its waves scaled to at most ~2.5 px), varied by the seed. */
export function profileLine(x1: number, y1: number, x2: number, y2: number, profile: number[], seed: string): string {
  const r = rng(seed + "p");
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const flip = r() < 0.5 ? -1 : 1;
  const rev = r() < 0.5;
  const prof = rev ? [...profile].reverse() : profile;
  const scale = Math.min(len, 90);
  const over = (r() - 0.3) * 2;
  const pts: Pt[] = prof.map((d, i) => {
    const t = i / (prof.length - 1);
    const along = -over + t * (len + 2 * over);
    const off = d * scale * flip;
    return [x1 + ux * along - uy * off, y1 + uy * along + ux * off];
  });
  return smooth(pts);
}

/** A pen stroke as it was written: straight pieces between its (many) points, no smoothing that would round corners. */
function polyline(p: Pt[]): string {
  if (p.length === 1) return `M${f(p[0][0])} ${f(p[0][1])}l0.01 0`;
  return `M${f(p[0][0])} ${f(p[0][1])}` + p.slice(1).map(([x, y]) => `L${f(x)} ${f(y)}`).join("");
}

/** Strokes drawn with the pen (100 × 100 box) at `size`: as they are, no added wobble. */
export function drawnPath(strokes: Stroke[], size: number): string {
  const s = size / 100;
  return strokes.map((st) => polyline(st.map(([x, y]) => [x * s, y * s] as Pt))).join("");
}

/** The same strokes stretched into a box w × h (for the circle of today, the check box). */
export function drawnPathIn(strokes: Stroke[], w: number, h: number, pad = 2): string {
  const flat = strokes.flat();
  if (!flat.length) return "";
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const kx = (w - 2 * pad) / Math.max(1, x1 - x0);
  const ky = (h - 2 * pad) / Math.max(1, y1 - y0);
  return strokes
    .map((st) => {
      return polyline(st.map(([x, y]) => [pad + (x - x0) * kx, pad + (y - y0) * ky] as Pt));
    })
    .join("");
}

/** A box drawn with four strokes; corners slightly crossed, like a quick sketch. */
export function roughRect(w: number, h: number, seed: string, inset = 2, amp = 1.2, profile?: number[]): string {
  const r = rng(seed + "r");
  const j = () => (r() - 0.5) * 2.4;
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const ln = (a: number, b: number, c: number, d: number, k: string) => (profile?.length ? profileLine(a, b, c, d, profile, seed + k) : roughLine(a, b, c, d, seed + k, amp));
  return [ln(x0 + j(), y0 + j(), x1 + j(), y0 + j(), "t"), ln(x1 + j(), y0 + j(), x1 + j(), y1 + j(), "d"), ln(x1 + j(), y1 + j(), x0 + j(), y1 + j(), "b"), ln(x0 + j(), y1 + j(), x0 + j(), y0 + j(), "s")].join("");
}

/** A circle drawn in one go: it starts somewhere, goes round and overlaps its start a little. */
export function roughCircle(cx: number, cy: number, rx: number, ry: number, seed: string, amp = 0.06, overlap = 0.35): string {
  const r = rng(seed + "c");
  const start = r() * Math.PI * 2;
  const total = Math.PI * 2 + overlap * (0.6 + r() * 0.8);
  const n = 28;
  const k1 = r() * Math.PI * 2;
  const k2 = r() * Math.PI * 2;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + t * total;
    // radius drifts: slightly egg-shaped, and the end does not land on the start
    const k = 1 + amp * (Math.sin(a * 2 + k1) * 0.6 + Math.sin(a * 3 + k2) * 0.4) + amp * 0.9 * t;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smooth(pts);
}

/** A filled blob (dots, the filled circle of today): a closed wobbly circle. */
export function roughBlob(cx: number, cy: number, r0: number, seed: string, amp = 0.08): string {
  const r = rng(seed + "b");
  const n = 12;
  const k1 = r() * Math.PI * 2;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + amp * Math.sin(a * 2 + k1) + amp * 0.6 * (r() - 0.5);
    pts.push([cx + Math.cos(a) * r0 * k, cy + Math.sin(a) * r0 * k]);
  }
  return smooth(pts, true) + "Z";
}

/** Strokes of an icon (in a 100 × 100 box) as a hand-drawn path, scaled to `size`. */
export function strokesPath(strokes: Stroke[], seed: string, size: number, amp = 1.6): string {
  const s = size / 100;
  return strokes
    .map((st, i) => {
      const scaled = st.map(([x, y]) => [x * s, y * s] as Pt);
      if (scaled.length === 1) {
        const [x, y] = scaled[0];
        return `M${f(x)} ${f(y)}l0.01 0`;
      }
      return smooth(wobble(scaled, `${seed}${i}`, amp * s * 1.6, Math.max(2, 7 * s)));
    })
    .join("");
}

// ---------------------------------------------------------------- building strokes for icons

export const line = (x1: number, y1: number, x2: number, y2: number): Stroke => [
  [x1, y1],
  [x2, y2],
];

/** Arc from angle a0 to a1 (degrees, 0 = right, clockwise on screen). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, ry = r): Stroke {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 15));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * ry] as Pt;
  });
}

export const circle = (cx: number, cy: number, r: number, ry = r): Stroke => arc(cx, cy, r, -100, 275, ry);

export function box(x: number, y: number, w: number, h: number, round = 0): Stroke {
  if (!round) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 1]];
  const r = round;
  return [
    ...arc(x + r, y + r, r, 180, 270),
    ...arc(x + w - r, y + r, r, 270, 360),
    ...arc(x + w - r, y + h - r, r, 0, 90),
    ...arc(x + r, y + h - r, r, 90, 180),
    [x, y + r - 1],
  ];
}
