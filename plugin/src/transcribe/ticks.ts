// Spunte misurate dai tratti, senza dipendere da come Claude legge l'immagine.
// Le caselle dei task sono quadratini (fatti con uno o più tratti) all'inizio di una riga; una spunta è un tratto
// nuovo (una V, una X, uno sgorbio) che parte dentro la casella o la attraversa. Per ogni casella spuntata si sa
// dov'è la riga: la spunta va a Claude come indicazione precisa e, se le caselle della pagina corrispondono una a una
// ai task della nota, si sa anche quale task è, anche se Claude non la vede.

import { Stroke } from "../types";

export interface TaskBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** I tratti della casella. */
  strokes: Stroke[];
}

export interface Tick {
  box: TaskBox;
  /** Posizione nella pagina (0 = la casella più in alto). */
  index: number;
  strokes: Stroke[];
}

interface B {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const ink = (s: Stroke) => s.tip !== 1 && s.pts.length >= 3;

function bounds(strokes: Stroke[]): B {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of strokes)
    for (let i = 0; i + 1 < s.pts.length; i += 3) {
      x0 = Math.min(x0, s.pts[i]);
      x1 = Math.max(x1, s.pts[i]);
      y0 = Math.min(y0, s.pts[i + 1]);
      y1 = Math.max(y1, s.pts[i + 1]);
    }
  return { x0, y0, x1, y1 };
}

function points(strokes: Stroke[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const s of strokes) for (let i = 0; i + 1 < s.pts.length; i += 3) out.push({ x: s.pts[i], y: s.pts[i + 1] });
  return out;
}

function pathLen(strokes: Stroke[]): number {
  let L = 0;
  for (const s of strokes) for (let i = 3; i + 1 < s.pts.length; i += 3) L += Math.hypot(s.pts[i] - s.pts[i - 3], s.pts[i + 1] - s.pts[i - 2]);
  return L;
}

/** Altezza tipica delle lettere della pagina (unità Ncode). */
function letterHeight(all: Stroke[]): number {
  const hs = all
    .map((s) => bounds([s]))
    .map((b) => b.y1 - b.y0)
    .filter((h) => h > 0.3 && h < 4)
    .sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 1.2;
}

/**
 * Un quadratino: largo e alto quasi uguale, il tratto corre lungo i quattro lati (i quattro angoli toccati e quasi
 * nessun punto in mezzo), il giro è lungo circa quanto il perimetro. Una «o» o una «a» non tocca gli angoli.
 */
function isBoxShape(strokes: Stroke[], H: number): B | null {
  const b = bounds(strokes);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const size = Math.max(w, h);
  if (size < 0.55 * H || size > 3.2 * H || w < 0.75 * h || h < 0.75 * w) return null;
  const pts = points(strokes);
  if (pts.length < 8) return null;
  const L = pathLen(strokes);
  if (L < 1.6 * (w + h) || L > 3 * (w + h)) return null;
  // gli angoli: tre ben toccati, il quarto (dove la penna parte e chiude) almeno sfiorato
  const corner = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ]
    .map(([cx, cy]) => Math.min(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) / size)
    .sort((a, c) => a - c);
  if (corner[2] > 0.2 || corner[3] > 0.36) return null;
  // i punti stanno sui lati (righe quasi dritte), non dentro
  const edge = 0.12 * size;
  const onEdge = pts.filter((p) => p.x - b.x0 < edge || b.x1 - p.x < edge || p.y - b.y0 < edge || b.y1 - p.y < edge).length;
  if (onEdge / pts.length < 0.78) return null;
  return b;
}

/**
 * Le caselle dei task già scritte sulla pagina (tra i tratti già trascritti `old`), in ordine dall'alto: un
 * quadratino con scritta subito a destra, sulla stessa riga, e niente scritta subito a sinistra.
 */
export function findTaskBoxes(old: Stroke[], all: Stroke[]): TaskBox[] {
  const ok = old.filter(ink).sort((a, b) => a.t - b.t);
  const every = all.filter(ink);
  const H = letterHeight(every);
  const out: TaskBox[] = [];
  const used = new Set<Stroke>();
  for (let i = 0; i < ok.length; i++) {
    if (used.has(ok[i])) continue;
    // un tratto solo, o due tratti di seguito (una casella fatta in due pezzi)
    for (let n = 1; n <= 2 && i + n <= ok.length; n++) {
      const group = ok.slice(i, i + n);
      if (n > 1 && group[n - 1].t - group[n - 2].t > 4000) break;
      const b = isBoxShape(group, H);
      if (!b) continue;
      const size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      const cy = (b.y0 + b.y1) / 2;
      const others = every.filter((s) => !group.includes(s));
      const rowOf = (s: Stroke) => {
        const sb = bounds([s]);
        const c = (sb.y0 + sb.y1) / 2;
        return c > cy - 0.9 * size && c < cy + 0.9 * size;
      };
      // la scritta a destra comincia staccata dalla casella (una «O» iniziale è attaccata alla lettera dopo);
      // i tratti che passano sopra la casella (spunte) non contano
      const overBox = (sb: B) => sb.x0 < b.x1 && sb.x1 > b.x0 && sb.y0 < b.y1 && sb.y1 > b.y0;
      const next = others
        .filter((s) => rowOf(s))
        .map((s) => bounds([s]))
        .filter((sb) => !overBox(sb) && sb.x0 >= b.x1 - 0.3 * size && sb.x0 <= b.x1 + 4 * H)
        .reduce((m, sb) => Math.min(m, sb.x0), Infinity);
      const right = Number.isFinite(next) && next - b.x1 >= 0.35 * size;
      // all'inizio della riga: niente scritta a sinistra sulla stessa riga
      const left = others.some((s) => {
        const sb = bounds([s]);
        return rowOf(s) && sb.x1 < b.x0 - 0.3 * size && sb.y1 - sb.y0 < 2.5 * H;
      });
      if (!right || left) continue;
      out.push({ ...b, strokes: group });
      group.forEach((s) => used.add(s));
      break;
    }
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/**
 * Le spunte tra i tratti nuovi: un tratto (o due, per una X) che parte dentro una casella o la attraversa, non più
 * grande di qualche casella e non una riga lunga sopra le parole (quella è una cancellatura).
 */
export function findTicks(fresh: Stroke[], boxes: TaskBox[]): Tick[] {
  const out: Tick[] = [];
  const taken = new Set<Stroke>();
  boxes.forEach((box, index) => {
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const pad = 0.3 * size;
    const inside = (p: { x: number; y: number }) => p.x >= box.x0 - pad && p.x <= box.x1 + pad && p.y >= box.y0 - pad && p.y <= box.y1 + pad;
    const hits = fresh.filter((s) => {
      if (!ink(s) || taken.has(s) || box.strokes.includes(s)) return false;
      const b = bounds([s]);
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      if (w > 4 * size || h > 3 * size) return false;
      // una linea piatta e lunga che va verso destra: cancellatura, non spunta
      if (h < 0.3 * size && w > 1.5 * size) return false;
      const pts = points([s]);
      const share = pts.filter(inside).length / pts.length;
      // la punta della V (il punto più basso) nella casella, o buona parte del tratto dentro
      const low = pts.reduce((a, p) => (p.y > a.y ? p : a), pts[0]);
      return share >= 0.3 || (inside(low) && share >= 0.15);
    });
    // una casella nuova disegnata sopra la vecchia (ripassata) non è una spunta
    if (hits.length && !isBoxShape(hits, size)) {
      hits.forEach((s) => taken.add(s));
      out.push({ box, index, strokes: hits });
    }
  });
  return out;
}

/** I task di una nota (le righe "- [ ]" / "- [x]" dei blocchi della pagina), in ordine. */
export function taskLines(blocks: string[]): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  for (const b of blocks)
    for (const l of b.split("\n")) {
      const m = /^\s*- \[([ xX])\] (.*)$/.exec(l);
      if (m) out.push({ text: m[2].trim(), done: m[1] !== " " });
    }
  return out;
}

/**
 * Le righe di scrittura tra i tratti dati (dall'alto): gruppi di tratti alla stessa altezza. Le code delle lettere
 * (g, p) non contano: si guarda il centro dei tratti piccoli. Serve a capire se Claude ha unito due righe in una.
 */
export function writtenRows(strokes: Stroke[], all: Stroke[]): { y0: number; y1: number; yc: number; x0: number; x1: number }[] {
  const H = letterHeight(all.filter(ink));
  const items = strokes
    .filter(ink)
    .map((s) => bounds([s]))
    .filter((b) => b.y1 - b.y0 < 2.5 * H && b.x1 - b.x0 < 12 * H)
    // sottolineature e linee lunghe e piatte: non sono una riga di parole
    .filter((b) => !(b.x1 - b.x0 > 3 * H && b.y1 - b.y0 < 0.4 * (b.x1 - b.x0)))
    .map((b) => ({ ...b, c: (b.y0 + b.y1) / 2 }))
    .sort((a, b) => a.c - b.c);
  const rows: { y0: number; y1: number; yc: number; x0: number; x1: number; n: number; sum: number }[] = [];
  for (const it of items) {
    const r = rows[rows.length - 1];
    if (r && it.c - r.sum / r.n < 1.3 * H) {
      r.n++;
      r.sum += it.c;
      r.y0 = Math.min(r.y0, it.y0);
      r.y1 = Math.max(r.y1, it.y1);
      r.x0 = Math.min(r.x0, it.x0);
      r.x1 = Math.max(r.x1, it.x1);
    } else rows.push({ y0: it.y0, y1: it.y1, yc: 0, x0: it.x0, x1: it.x1, n: 1, sum: it.c });
  }
  // una riga vera ha qualche tratto (non un puntino isolato)
  return rows.filter((r) => r.n >= 2).map((r) => ({ y0: r.y0, y1: r.y1, yc: r.sum / r.n, x0: r.x0, x1: r.x1 }));
}
