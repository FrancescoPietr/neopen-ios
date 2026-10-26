// Drawings made with the pen for the look of the app (icons, check box, the circle of today, the line…):
// the strokes as written (Ncode units) become a small drawing in a 100 × 100 box, centered, simplified.

export type Pt = [number, number];

/** Points of a pen stroke (pts = x, y, force, …). */
export function strokePoints(pts: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) if (pts[i] >= 0 && pts[i + 1] >= 0) out.push([pts[i], pts[i + 1]]);
  return out;
}

/** Ramer–Douglas–Peucker: fewer points, same shape. */
export function simplify(p: Pt[], eps: number): Pt[] {
  if (p.length < 3) return p.slice();
  const [a, b] = [p[0], p[p.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let worst = -1;
  let at = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = len === 0 ? Math.hypot(p[i][0] - a[0], p[i][1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - p[i][1]) - (a[0] - p[i][0]) * (b[1] - a[1])) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) return [a, b];
  return [...simplify(p.slice(0, at + 1), eps).slice(0, -1), ...simplify(p.slice(at), eps)];
}

/**
 * The strokes as a drawing in a 100 × 100 box: the longer side fills `fill` (80 = a margin of 10), centered;
 * points rounded to 0.1. A dot (a tiny stroke) stays a dot.
 */
export function normalize(strokes: number[][], fill = 80): Pt[][] {
  const all = strokes.map(strokePoints).filter((s) => s.length);
  const flat = all.flat();
  if (!flat.length) return [];
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = x1 - x0;
  const h = y1 - y0;
  const size = Math.max(w, h);
  const k = size > 0 ? fill / size : 1;
  const ox = 50 - (w * k) / 2;
  const oy = 50 - (h * k) / 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  return all.map((s) => {
    const pts = simplify(
      s.map(([x, y]) => [ox + (x - x0) * k, oy + (y - y0) * k] as Pt),
      0.3
    ).map(([x, y]) => [r(x), r(y)] as Pt);
    return pts.length === 1 || (pts.length === 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 2) ? [pts[0]] : pts;
  });
}

/**
 * The character of a drawn line: how far it leaves the straight line from its start to its end, at `n` points
 * along it, as a fraction of its length (so it can be stretched to any width). Capped to ±3 %.
 */
export function lineProfile(strokes: number[][], n = 24): number[] {
  const longest = strokes.map(strokePoints).sort((a, b) => length(b) - length(a))[0];
  if (!longest || longest.length < 2) return [];
  let pts = longest;
  if (pts[0][0] > pts[pts.length - 1][0]) pts = [...pts].reverse();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  // along (0..1) and across (fraction of the length) of each point
  const proj = pts.map(([x, y]) => [((x - a[0]) * ux + (y - a[1]) * uy) / len, (-(x - a[0]) * uy + (y - a[1]) * ux) / len] as Pt);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let j = proj.findIndex((p) => p[0] >= t);
    if (j <= 0) j = j === 0 ? 1 : proj.length - 1;
    const [p, q] = [proj[j - 1], proj[j]];
    const f = q[0] === p[0] ? 0 : (t - p[0]) / (q[0] - p[0]);
    out.push(Math.max(-0.03, Math.min(0.03, p[1] + (q[1] - p[1]) * Math.max(0, Math.min(1, f)))));
  }
  return out;
}

function length(p: Pt[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}
