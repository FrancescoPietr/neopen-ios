// Rientro delle righe: dove comincia ogni riga sulla carta, rispetto al punto elenco da cui dipende.
// Claude dà il rettangolo di ogni riga (grossolano); lo si affina con i tratti veri, poi la posizione
// orizzontale diventa un certo numero di spazi (en space) davanti alla riga di continuazione.

import { Stroke } from "../types";
import { TranscribedLine } from "./claude";

const isDash = (t: string) => /^[-*•–]\s/.test(t.trim());

export function applyIndents(lines: TranscribedLine[], png: { ox: number; oy: number; scale: number }, strokes: Stroke[]): number {
  const bbox = strokes
    .filter((s) => s.tip !== 1 && s.pts.length >= 3)
    .map((s) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < s.pts.length; i += 3) {
        x0 = Math.min(x0, s.pts[i]);
        x1 = Math.max(x1, s.pts[i]);
        y0 = Math.min(y0, s.pts[i + 1]);
        y1 = Math.max(y1, s.pts[i + 1]);
      }
      return { x0: (x0 - png.ox) * png.scale, x1: (x1 - png.ox) * png.scale, yc: ((y0 + y1) / 2 - png.oy) * png.scale };
    });
  /** Estremi orizzontali (px) di una riga: dai tratti dentro il suo rettangolo, altrimenti quelli di Claude. */
  const span = (b: number[]): [number, number] => {
    const h = b[3] - b[1];
    const inside = bbox.filter((s) => s.yc > b[1] + 0.25 * h && s.yc < b[3] - 0.25 * h && s.x1 > b[0] - 40 && s.x0 < b[2] + 40);
    if (!inside.length) return [b[0], b[2]];
    return [Math.min(...inside.map((s) => s.x0)), Math.max(...inside.map((s) => s.x1))];
  };
  let parent: { x0: number; x1: number; len: number } | null = null;
  let n = 0;
  for (const l of lines) {
    if (l.kind !== "text" || !l.box || !l.text.trim()) {
      if (l.kind !== "text") parent = null;
      continue;
    }
    const [x0, x1] = span(l.box);
    const t = l.text.trim();
    if (isDash(t)) {
      parent = { x0, x1, len: t.length };
      continue;
    }
    if (!parent) continue;
    const pxChar = (parent.x1 - parent.x0) / Math.max(parent.len, 8);
    if (!(pxChar > 0)) continue;
    // "- " occupa 2 caratteri: il testo di una riga di continuazione parte già da lì
    const spaces = Math.round((x0 - parent.x0) / pxChar) - 2;
    if (spaces >= 2) {
      l.indent = Math.min(spaces, 40);
      n++;
    }
  }
  return n;
}
