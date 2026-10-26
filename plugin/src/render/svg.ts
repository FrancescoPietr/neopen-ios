// Converte i tratti di una pagina in un SVG vettoriale.
// Le coordinate restano in unità Ncode (1 unità ≈ 2,37 mm): l'SVG si adatta da solo.

import { PageData, Stroke } from "../types";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PAD = 2;

export function strokeBounds(strokes: Stroke[]): Bounds | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of strokes) {
    if (s.tip === 1) continue;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i],
        y = s.pts[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Path SVG con curve quadratiche tra i punti medi: tratto morbido anche con pochi punti. */
export function strokePath(pts: number[], dx = 0, dy = 0, scale = 1): string {
  const n = pts.length / 3;
  const X = (i: number) => ((pts[i * 3] - dx) * scale).toFixed(2);
  const Y = (i: number) => ((pts[i * 3 + 1] - dy) * scale).toFixed(2);
  if (n === 0) return "";
  if (n === 1) return `M${X(0)} ${Y(0)}l0.01 0`;
  let d = `M${X(0)} ${Y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (((pts[i * 3] + pts[(i + 1) * 3]) / 2 - dx) * scale).toFixed(2);
    const my = (((pts[i * 3 + 1] + pts[(i + 1) * 3 + 1]) / 2 - dy) * scale).toFixed(2);
    d += `Q${X(i)} ${Y(i)} ${mx} ${my}`;
  }
  d += `L${X(n - 1)} ${Y(n - 1)}`;
  return d;
}

/** Spessore in base alla pressione media del tratto. */
export function strokeWidth(s: Stroke, maxForce: number, base: number): number {
  let sum = 0,
    n = 0;
  for (let i = 2; i < s.pts.length; i += 3) {
    sum += s.pts[i];
    n++;
  }
  const avg = n ? sum / n : maxForce / 2;
  const r = Math.max(0, Math.min(1, avg / (maxForce || 1023)));
  return base * (0.6 + 0.8 * r);
}

export function pageToSvg(page: PageData, opts: { maxForce?: number; ink?: string; paper?: string } = {}): string {
  const ink = opts.ink ?? "#1f2328";
  const paper = opts.paper ?? "#ffffff";
  const maxForce = opts.maxForce ?? 1023;
  const b = strokeBounds(page.strokes) ?? { minX: 0, minY: 0, maxX: 60, maxY: 85 };
  // unità Ncode moltiplicate per 10 per avere numeri comodi
  const S = 10;
  const ox = b.minX - PAD,
    oy = b.minY - PAD;
  const w = (b.maxX - b.minX + PAD * 2) * S;
  const h = (b.maxY - b.minY + PAD * 2) * S;

  const paths = page.strokes
    .filter((s) => s.tip !== 1 && s.pts.length >= 3)
    .map(
      (s) =>
        `<path d="${strokePath(s.pts, ox, oy, S)}" stroke-width="${strokeWidth(s, maxForce, 0.22 * S).toFixed(2)}"/>`
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${(w / S * 2.371).toFixed(1)}mm" height="${(h / S * 2.371).toFixed(1)}mm">
<rect width="100%" height="100%" rx="${(0.8 * S).toFixed(1)}" fill="${paper}"/>
<g fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">
${paths}
</g>
</svg>
`;
}

/**
 * Più pagine (una nota che continua su più pagine) in un'unica immagine:
 * le pagine sono impilate nell'ordine della catena, ognuna nella sua posizione reale sul foglio,
 * così gli spazi restano veri e ciò che aggiungi a una pagina resta nella sua zona.
 * Si ritaglia solo il bianco prima del primo tratto e dopo l'ultimo.
 */
export function groupToSvg(
  pages: PageData[],
  opts: { maxForce?: number; ink?: string; paper?: string; pageHeight?: number } = {}
): string {
  const ink = opts.ink ?? "#1f2328";
  const paper = opts.paper ?? "#ffffff";
  const maxForce = opts.maxForce ?? 1023;
  const S = 10;
  const bounds = pages.map((p) => strokeBounds(p.strokes));
  const valid = bounds.filter((b): b is Bounds => !!b);
  if (!valid.length) return pageToSvg(pages[0] ?? { version: 1, key: { section: 0, owner: 0, note: 0, page: 0 }, created: 0, updated: 0, strokes: [] }, opts);

  // altezza del foglio: almeno A5 (≈ 88 unità), o quanto serve per contenere i tratti
  const pageH = Math.max(opts.pageHeight ?? 0, 88, ...valid.map((b) => b.maxY + 3));
  const minX = Math.min(...valid.map((b) => b.minX)) - PAD;
  const maxX = Math.max(...valid.map((b) => b.maxX)) + PAD;
  const firstIdx = bounds.findIndex((b) => !!b);
  const lastIdx = bounds.length - 1 - [...bounds].reverse().findIndex((b) => !!b);
  const top = firstIdx * pageH + bounds[firstIdx]!.minY - PAD;
  const bottom = lastIdx * pageH + bounds[lastIdx]!.maxY + PAD;

  const w = (maxX - minX) * S;
  const h = (bottom - top) * S;
  const parts: string[] = [];
  pages.forEach((p, i) => {
    const oy = top - i * pageH; // unità Ncode: la pagina i è spostata in basso di i × altezza foglio
    if (i > 0) {
      const y = ((i * pageH - top) * S).toFixed(1);
      if (Number(y) > 0 && Number(y) < h) {
        parts.push(`<line x1="0" y1="${y}" x2="${w.toFixed(1)}" y2="${y}" stroke="#d0d7de" stroke-width="${(0.15 * S).toFixed(2)}" stroke-dasharray="${S} ${S}"/>`);
      }
    }
    for (const s of p.strokes) {
      if (s.tip === 1 || s.pts.length < 3) continue;
      parts.push(
        `<path d="${strokePath(s.pts, minX, oy, S)}" fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth(s, maxForce, 0.22 * S).toFixed(2)}"/>`
      );
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${((w / S) * 2.371).toFixed(1)}mm" height="${((h / S) * 2.371).toFixed(1)}mm">
<rect width="100%" height="100%" rx="${(0.8 * S).toFixed(1)}" fill="${paper}"/>
${parts.join("\n")}
</svg>
`;
}
