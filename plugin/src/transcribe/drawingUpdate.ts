// Disegni già nella nota che si allungano: tratti nuovi attaccati al disegno (lo completano) e scritte nuove
// accanto (diventano sue scritte). Per ritrovare il disegno, accanto all'SVG c'è un .json con i tratti e la tela.

import { strokeBounds } from "../render/svg";
import { Stroke } from "../types";
import { Anchor, Canvas, touches } from "./drawings";

export interface DrawingRecord {
  v: 1;
  /** Istante (t) di ogni tratto del disegno. */
  strokes: number[];
  canvas: Canvas;
}

export const recordPathOf = (svgPath: string): string => svgPath.replace(/\.svg$/i, ".json");

/**
 * Tratti nuovi che completano il disegno senza bisogno di Claude: stanno (quasi) tutti DENTRO il contorno del
 * disegno e lo toccano (anche attraverso altri tratti nuovi). Tutto quello che esce dal contorno, e i tratti
 * attaccati a qualcosa scritto fuori (la punta di una freccia che parte da una scritta), lo giudica Claude:
 * una freccia con una nota accanto diventa freccia del disegno + scritta, non scarabocchio.
 */
export function findExtensions(drawing: Stroke[], fresh: Stroke[]): Stroke[] {
  const db = strokeBounds(drawing);
  if (!db || !fresh.length) return [];
  const share = (s: Stroke) => {
    let n = 0,
      tot = 0;
    for (let i = 0; i + 1 < s.pts.length; i += 3) {
      tot++;
      const x = s.pts[i],
        y = s.pts[i + 1];
      if (x >= db.minX && x <= db.maxX && y >= db.minY && y <= db.maxY) n++;
    }
    return tot ? n / tot : 0;
  };
  const near = (a: Stroke, b: Stroke, gap: number) => {
    const p = strokeBounds([a])!,
      q = strokeBounds([b])!;
    return p.minX - gap <= q.maxX && q.minX - gap <= p.maxX && p.minY - gap <= q.maxY && q.minY - gap <= p.maxY;
  };
  const inside = fresh.filter((s) => share(s) >= 0.9);
  const outside = fresh.filter((s) => share(s) < 0.9);
  const members: Stroke[] = [...drawing];
  const out: Stroke[] = [];
  const left = new Set(inside);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of [...left]) {
      if (members.some((m) => near(s, m, 0.8) && touches(s, m, 0.8))) {
        members.push(s);
        out.push(s);
        left.delete(s);
        grew = true;
      }
    }
  }
  // via quelli collegati a scrittura nuova fuori dal disegno (e, a catena, quelli attaccati a loro)
  const linked = new Set<Stroke>();
  const queue = out.filter((s) => outside.some((o) => near(s, o, 1) && touches(s, o, 1)));
  while (queue.length) {
    const s = queue.pop()!;
    if (linked.has(s)) continue;
    linked.add(s);
    for (const t of out) if (!linked.has(t) && near(s, t, 0.8) && touches(s, t, 0.8)) queue.push(t);
  }
  return out.filter((s) => !linked.has(s));
}

/** Tratti nuovi indicati da Claude come aggiunta a un disegno (nel rettangolo, o attaccati a quelli). */
export function strokesInBox(box: { minX: number; minY: number; maxX: number; maxY: number }, fresh: Stroke[]): Stroke[] {
  return fresh.filter((s) => {
    let n = 0,
      tot = 0;
    for (let i = 0; i + 1 < s.pts.length; i += 3) {
      tot++;
      if (s.pts[i] >= box.minX && s.pts[i] <= box.maxX && s.pts[i + 1] >= box.minY && s.pts[i + 1] <= box.maxY) n++;
    }
    return tot > 0 && n / tot >= 0.6;
  });
}

/**
 * Disegni fatti prima che ci fosse il .json: si ritrovano i tratti della pagina confrontando il primo punto
 * di ogni tratto dell'SVG (spostato dell'origine della tela) con i tratti della pagina.
 */
export function reconstructRecord(svg: string, firstT: number, page: Stroke[]): DrawingRecord | null {
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return null;
  const [vx, vy, vw, vh] = vb.slice(1).map(Number);
  const starts = [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]) / 10, y: Number(m[2]) / 10 }));
  if (!starts.length) return null;
  const first = page.find((s) => s.t === firstT);
  const cell = (x: number, y: number) => `${Math.round(x * 4)}|${Math.round(y * 4)}`;
  const grid = new Map<string, Stroke[]>();
  for (const s of page) {
    if (s.pts.length < 3) continue;
    const k = cell(s.pts[0], s.pts[1]);
    grid.set(k, [...(grid.get(k) ?? []), s]);
  }
  // (più tratti possono cominciare nello stesso punto: ognuno si usa una volta sola)
  const lookup = (x: number, y: number, taken: Set<Stroke>): Stroke | undefined => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = `${Math.round(x * 4) + dx}|${Math.round(y * 4) + dy}`;
        const hit = grid.get(k)?.find((s) => !taken.has(s) && Math.abs(s.pts[0] - x) < 0.06 && Math.abs(s.pts[1] - y) < 0.06);
        if (hit) return hit;
      }
    return undefined;
  };
  // origine della tela: dal tratto che dà il nome al file, confrontato con ogni inizio di tratto dell'SVG
  const tries = first ? starts.map((p) => ({ ox: first.pts[0] - p.x, oy: first.pts[1] - p.y })) : [];
  let best: { ox: number; oy: number; hits: Stroke[] } | null = null;
  for (const o of tries.slice(0, 400)) {
    const hits: Stroke[] = [];
    const taken = new Set<Stroke>();
    for (const p of starts) {
      const s = lookup(p.x + o.ox, p.y + o.oy, taken);
      if (s) {
        hits.push(s);
        taken.add(s);
      }
      if (hits.length + (starts.length - starts.indexOf(p) - 1) < (best?.hits.length ?? 0)) break;
    }
    if (!best || hits.length > best.hits.length) best = { ...o, hits };
    if (best.hits.length === starts.length) break;
  }
  if (!best || best.hits.length < starts.length * 0.8) return null;
  return {
    v: 1,
    strokes: best.hits.map((s) => s.t),
    canvas: { ox: best.ox + vx / 10, oy: best.oy + vy / 10, W: vw / 10, H: vh / 10 },
  };
}

export const sameCanvas = (a: Canvas, b: Canvas): boolean =>
  Math.abs(a.ox - b.ox) < 1e-6 && Math.abs(a.oy - b.oy) < 1e-6 && Math.abs(a.W - b.W) < 1e-6 && Math.abs(a.H - b.H) < 1e-6;

export type { Anchor };

/** Tratti nuovi nel rettangolo di Claude attaccati al disegno (anche uno all'altro): un pezzo aggiunto di lato. */
export function growInto(drawing: Stroke[], fresh: Stroke[], box: { minX: number; minY: number; maxX: number; maxY: number }): Stroke[] {
  const inside = new Set(strokesInBox(box, fresh));
  const members = [...drawing];
  const out: Stroke[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of [...inside]) {
      if (members.some((m) => touches(s, m, 0.8))) {
        members.push(s);
        out.push(s);
        inside.delete(s);
        grew = true;
      }
    }
  }
  return out;
}
