// Sottolineatura o cancellatura? Lo si capisce dalla geometria dei tratti, meglio che dall'immagine:
// una linea quasi orizzontale sotto il fondo delle lettere è una sottolineatura,
// una che passa a metà altezza delle lettere è una cancellatura. L'esito va a Claude come indizio.

import { Stroke } from "../types";

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  yc: number;
}

function box(s: Stroke): Box {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity,
    sum = 0,
    n = 0;
  for (let i = 0; i + 1 < s.pts.length; i += 3) {
    const x = s.pts[i],
      y = s.pts[i + 1];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    sum += y;
    n++;
  }
  return { x0, x1, y0, y1, yc: n ? sum / n : 0 };
}

/** Linea quasi orizzontale, lunga almeno ~5 mm. */
function isLine(b: Box): boolean {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return w >= 2 && h <= Math.max(1.2, w * 0.22);
}

/**
 * Doppia linea fatta con un solo tratto (avanti e indietro): restituisce la y media del ramo più alto, o null.
 */
function doubleStroke(s: Stroke, b: Box): number | null {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w < 2 || h > 2.5 || h < 0.2) return null;
  const n = Math.floor(s.pts.length / 3);
  if (n < 4) return null;
  // punto di inversione: il più a destra (o il più a sinistra) lontano dagli estremi
  let iMax = 0,
    iMin = 0;
  for (let i = 0; i < n; i++) {
    if (s.pts[i * 3] > s.pts[iMax * 3]) iMax = i;
    if (s.pts[i * 3] < s.pts[iMin * 3]) iMin = i;
  }
  for (const turn of [iMax, iMin]) {
    if (turn < 1 || turn > n - 2) continue;
    const legA: number[] = [],
      legB: number[] = [];
    for (let i = 0; i <= turn; i++) legA.push(i);
    for (let i = turn; i < n; i++) legB.push(i);
    const span = (idx: number[]) => Math.abs(s.pts[idx[idx.length - 1] * 3] - s.pts[idx[0] * 3]);
    if (span(legA) < 0.5 * w || span(legB) < 0.5 * w) continue;
    const meanY = (idx: number[]) => idx.reduce((a, i) => a + s.pts[i * 3 + 1], 0) / idx.length;
    const ya = meanY(legA),
      yb = meanY(legB);
    if (Math.abs(ya - yb) >= 0.2 && Math.abs(ya - yb) <= 2) return Math.min(ya, yb);
  }
  return null;
}

function median(v: number[]): number {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

export type LineKind = "under" | "through" | "double";

/** Classifica le linee nuove rispetto al testo che hanno attorno (vecchio o scritto insieme). */
export function classifyLines(newStrokes: Stroke[], allStrokes: Stroke[]): { kind: LineKind; box: Box; stroke: Stroke }[] {
  const ink = allStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 3);
  const boxes = new Map(ink.map((s) => [s, box(s)]));
  const dbl = new Map<Stroke, number>();
  for (const s of newStrokes) {
    if (s.tip === 1 || s.pts.length < 3) continue;
    const b = boxes.get(s) ?? box(s);
    const y = doubleStroke(s, b);
    if (y !== null) dbl.set(s, y);
  }
  const lines = newStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 3 && (isLine(boxes.get(s) ?? box(s)) || dbl.has(s)));
  const lineSet = new Set(lines);
  const out: { kind: LineKind; box: Box; stroke: Stroke }[] = [];
  for (const l of lines) {
    const b0 = boxes.get(l) ?? box(l);
    const b = dbl.has(l) ? { ...b0, yc: dbl.get(l)! } : b0;
    const w = b.x1 - b.x0;
    // lettere vicine: sovrapposte in orizzontale alla linea, poco sopra o attorno ad essa
    const near = ink
      .filter((s) => !lineSet.has(s))
      .map((s) => boxes.get(s)!)
      .filter((o) => {
        const overlap = Math.min(o.x1, b.x1) - Math.max(o.x0, b.x0);
        const h = o.y1 - o.y0;
        return overlap > Math.min(0.3 * (o.x1 - o.x0), 0.3 * w) && h > 0.3 && h < 6 && (o.y0 + o.y1) / 2 > b.yc - 4.5 && (o.y0 + o.y1) / 2 < b.yc + 1.5;
      });
    if (near.length < 1) continue;
    const top = median(near.map((o) => o.y0));
    const bottom = median(near.map((o) => o.y1));
    const hgt = Math.max(0.3, bottom - top);
    const rel = (b.yc - top) / hgt; // 0 = in cima alle lettere, 1 = sul fondo (y cresce verso il basso)
    if (rel >= 0.8) out.push({ kind: dbl.has(l) ? "double" : "under", box: b, stroke: l });
    else if (rel >= 0.2 && rel <= 0.75 && !dbl.has(l)) out.push({ kind: "through", box: b, stroke: l });
  }
  return out;
}

/** Righe di testo (non linee) che stanno sopra una certa altezza della pagina. */
function rowsAbove(y: number, allStrokes: Stroke[], x0 = -Infinity, x1 = Infinity): number {
  // solo la scrittura sopra il titolo (non un "Ciao" scritto in alto a destra, lontano)
  const items = allStrokes
    .filter((s) => s.tip !== 1 && s.pts.length >= 3)
    .map(box)
    .filter((b) => !isLine(b) && b.y1 - b.y0 < 6 && (b.y0 + b.y1) / 2 < y - 0.2 && (b.x0 + b.x1) / 2 >= x0 - 3 && (b.x0 + b.x1) / 2 <= x1 + 3)
    .map((b) => ({ c: (b.y0 + b.y1) / 2, big: b.x1 - b.x0 >= 1 || b.y1 - b.y0 >= 1 }))
    .sort((p, q) => p.c - q.c);
  // una riga va dal suo primo tratto a 1,6 unità più giù (non "a catena": righe vicine non si fondono);
  // conta solo se ha almeno due tratti o uno grande (un puntino da solo non è una riga)
  let rows = 0;
  let start = -Infinity;
  let members: { big: boolean }[] = [];
  const close = () => {
    if (members.length >= 2 || members.some((m) => m.big)) rows++;
  };
  for (const it of items) {
    if (it.c - start > 1.6) {
      close();
      start = it.c;
      members = [];
    }
    members.push(it);
  }
  close();
  return rows;
}

export interface UnderlineReport {
  /** Frase per Claude (in inglese, come le istruzioni), vuota se non c'è niente di sicuro da dire. */
  hint: string;
  /** Doppie sottolineature trovate: altezza e se stanno in cima alla pagina (sopra solo il titolo ed eventualmente un #tag). */
  doubles: { y: number; top: boolean }[];
  /** Tratti nuovi che cancellano parole. */
  strikes: Stroke[];
  /** Cancellature sopra testo già trascritto: si disegnano in rosso. */
  red: Stroke[];
  /** Cancellature sopra testo nuovo: non si disegnano (le parole cancellate sono tolte). */
  hidden: Stroke[];
  /** Tratti nuovi cancellati (parole, pezzi di parola, caselle di task cancellati): non si disegnano. */
  erased: Stroke[];
}

export function underlineReport(newStrokes: Stroke[], allStrokes: Stroke[]): UnderlineReport {
  const strikes = findStrikes(newStrokes, allStrokes);
  const struck = new Set(strikes);
  const isNew = new Set(newStrokes);
  // cancellature sopra testo già trascritto (grigio): restano, in rosso, per dire a Claude cosa togliere dalla nota
  const red = strikes.filter((s) => {
    const sb = box(s);
    return allStrokes.some((o) => {
      if (isNew.has(o) || struck.has(o) || o.tip === 1) return false;
      const ob = box(o);
      return !(ob.x1 < sb.x0 || ob.x0 > sb.x1 || ob.y1 < sb.y0 || ob.y0 > sb.y1) && intersections(s, o) > 0;
    });
  });
  const hidden = strikes.filter((s) => !red.includes(s));
  // parole nuove cancellate: si tolgono dall'immagine (con le loro linee), così non vengono trascritte
  const erased = strikeErasure(hidden, allStrokes).filter((s) => isNew.has(s) && !struck.has(s));
  const gone = new Set(erased);
  const remaining = allStrokes.filter((s) => !gone.has(s) && !struck.has(s));
  // le linee "a metà" non confermate (es. il trattino di un #) si tacciono
  const found = classifyLines(newStrokes.filter((s) => !gone.has(s) && !struck.has(s)), remaining)
    .filter((l) => l.kind !== "through")
    .sort((a, b) => a.box.yc - b.box.yc);
  const notes: string[] = [];
  if (red.length)
    notes.push(
      `The ${red.length === 1 ? "line" : `${red.length} lines`} drawn in RED ${red.length === 1 ? "crosses" : "cross"} already transcribed (gray) words: measured from the pen strokes, ${red.length === 1 ? "it is a STRIKE-THROUGH" : "they are STRIKE-THROUGHS"} (never ticks, never underlines): those gray words are DELETED (deleted_text).`
    );
  if (erased.length) notes.push("New writing that was struck through has already been removed from this image: transcribe only what you see.");
  const redNote = notes.join(" ");
  const base = { strikes, red, hidden, erased };
  if (!found.length) return { hint: redNote, doubles: [], ...base };
  const items: string[] = [];
  const doubles: { y: number; top: boolean }[] = [];
  const describeDouble = (y: number, x0: number, x1: number): string | null => {
    // la stessa doppia sottolineatura ripassata (due coppie di linee sotto lo stesso titolo): una sola
    if (doubles.some((d) => Math.abs(d.y - y) < 2)) return null;
    // righe sopra la linea: il titolo stesso, più al massimo una riga col #tag
    const top = rowsAbove(y, remaining, x0, x1) <= 2;
    doubles.push({ y, top });
    return top
      ? "a DOUBLE UNDERLINE at the TOP of the page (the words above it are the page title → page_title)"
      : "a DOUBLE UNDERLINE in the MIDDLE of the page (there is other text above it → a mid-page title: write it as \"== title\" in lines, it is NOT page_title)";
  };
  for (let i = 0; i < found.length; i++) {
    const a = found[i];
    const b = found[i + 1];
    if (a.kind === "double") {
      const t = describeDouble(a.box.yc, a.box.x0, a.box.x1);
      if (t) items.push(t);
    } else if (
      a.kind === "under" &&
      b?.kind === "under" &&
      Math.abs(b.box.yc - a.box.yc) < 1.6 &&
      Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0) > 0.5 * Math.min(a.box.x1 - a.box.x0, b.box.x1 - b.box.x0)
    ) {
      const t = describeDouble(a.box.yc, Math.min(a.box.x0, b.box.x0), Math.max(a.box.x1, b.box.x1));
      if (t) items.push(t);
      i++;
    } else if (a.box.x1 - a.box.x0 >= 3) {
      // (linee corte, sotto i 7 mm circa: di solito il taglio di una "t" o un pezzo di lettera, non si segnalano)
      items.push("a SINGLE UNDERLINE (below the words: they are NOT deleted and NOT a title — transcribe them in **bold**)");
    }
  }
  const lines = items.length ? `Measured from the pen strokes (reliable), from top to bottom the black lines under words are: ${items.join("; ")}.` : "";
  return { hint: [lines, redNote].filter(Boolean).join(" "), doubles, ...base };
}

// ------------------------------------------------------------- cancellature

function pathLen(s: Stroke): number {
  let L = 0;
  for (let i = 3; i + 1 < s.pts.length; i += 3) L += Math.hypot(s.pts[i] - s.pts[i - 3], s.pts[i + 1] - s.pts[i - 2]);
  return L;
}

/** Quante volte il tratto inverte la direzione in verticale (una parola in corsivo lo fa a ogni lettera). */
function yReversals(s: Stroke, minStep: number): number {
  let dir = 0,
    n = 0,
    anchor = s.pts[1];
  for (let i = 4; i < s.pts.length; i += 3) {
    const d = s.pts[i] - anchor;
    if (Math.abs(d) < minStep) continue;
    const nd = Math.sign(d);
    if (dir && nd !== dir) n++;
    dir = nd;
    anchor = s.pts[i];
  }
  return n;
}

/**
 * Spunta a V: il tratto scende (verso il basso della pagina) fino a un vertice nella prima parte
 * e poi risale di parecchio. Anche se il braccio lungo passa sopra le parole, non è una cancellatura.
 */
function isTick(s: Stroke, H: number): boolean {
  const n = Math.floor(s.pts.length / 3);
  if (n < 3) return false;
  let iv = 0;
  for (let i = 1; i < n; i++) if (s.pts[i * 3 + 1] > s.pts[iv * 3 + 1]) iv = i;
  // lunghezza percorsa fino al vertice, rispetto al totale
  let L = 0,
    Lv = 0;
  for (let i = 1; i < n; i++) {
    L += Math.hypot(s.pts[i * 3] - s.pts[(i - 1) * 3], s.pts[i * 3 + 1] - s.pts[(i - 1) * 3 + 1]);
    if (i === iv) Lv = L;
  }
  const down = s.pts[iv * 3 + 1] - s.pts[1];
  const up = s.pts[iv * 3 + 1] - s.pts[(n - 1) * 3 + 1];
  // il braccio che risale è ripido (una cancellatura obliqua con un uncino iniziale sale molto più piano)
  const armDx = Math.abs(s.pts[(n - 1) * 3] - s.pts[iv * 3]);
  return L > 0 && Lv / L > 0.03 && Lv / L < 0.45 && down >= 0.35 * H && up >= 1.2 * H && up > 1.5 * down && up >= 0.7 * armDx && yReversals(s, 0.3 * H) <= 2;
}

/** Tratti (non cancellature) attraversati da una cancellatura, o lettere piccole proprio sulla sua linea. */
export function struckStrokes(strikes: Stroke[], allStrokes: Stroke[]): Stroke[] {
  if (!strikes.length) return [];
  const st = new Set(strikes);
  const ink = allStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 3 && !st.has(s));
  const boxes = new Map(ink.map((s) => [s, box(s)]));
  const H = Math.max(0.5, median([...boxes.values()].filter((b) => b.y1 - b.y0 > 0.3 && b.y1 - b.y0 < 4 && b.x1 - b.x0 < 4).map((b) => b.y1 - b.y0)) || 1.2);
  // le linee dritte cancellano anche le lettere vicine; gli scarabocchi solo quello che toccano
  const sb = strikes.map((s) => ({ s, b: box(s), band: (yReversals(s, 0.3 * H) / Math.max(1e-6, pathLen(s)) <= 0.15 ? 1.0 : 0.5) * H }));
  // sottolineature e doppie sottolineature (titoli) non si toccano mai
  const keep = new Set(classifyLines(ink, allStrokes).filter((l) => l.kind !== "through").map((l) => l.stroke));
  const boxesT = taskBoxes(ink, H);
  const out: Stroke[] = [];
  for (const o of ink) {
    const ob = boxes.get(o)!;
    const h = ob.y1 - ob.y0,
      w = ob.x1 - ob.x0;
    if (isDrawing(ob, H) || keep.has(o)) continue; // disegni grandi e sottolineature: non si toccano
    if (boxesT.has(o)) continue; // caselle dei task: restano (da sole non diventano testo)
    const near = sb.filter(({ b }) => !(ob.x1 < b.x0 - 0.5 || ob.x0 > b.x1 + 0.5 || ob.y1 < b.y0 - H || ob.y0 > b.y1 + H));
    if (!near.length) continue;
    if (near.some(({ s }) => intersections(s, o) > 0)) {
      out.push(o);
      continue;
    }
    // lettere vicine alla linea (dentro la sua lunghezza): fanno parte delle parole cancellate
    const cx = (ob.x0 + ob.x1) / 2,
      cy = (ob.y0 + ob.y1) / 2;
    if (w < 6 * H && near.some(({ s, b, band }) => cx >= b.x0 && cx <= b.x1 && distToPath(s, cx, cy) < band)) out.push(o);
  }
  return out;
}

/** Tutte le y in cui il tratto attraversa la verticale x. */
function ysAt(s: Stroke, x: number): number[] {
  const out: number[] = [];
  for (let i = 3; i + 1 < s.pts.length; i += 3) {
    const xa = s.pts[i - 3],
      ya = s.pts[i - 2],
      xb = s.pts[i],
      yb = s.pts[i + 1];
    if ((x < xa && x < xb) || (x > xa && x > xb)) continue;
    out.push(xa === xb ? (ya + yb) / 2 : ya + ((yb - ya) * (x - xa)) / (xb - xa));
  }
  return out;
}

/** Tratto di un disegno (grande in entrambe le direzioni o molto alto), non una lettera o parola. */
function isDrawing(b: Box, H: number): boolean {
  const h = b.y1 - b.y0,
    w = b.x1 - b.x0;
  return h > 4.5 * H || (h > 3 * H && w > 4 * H);
}

/** Una casella da task: un tratto chiuso, più o meno quadrato, grande come una lettera, con almeno 3 angoli. */
function isBoxShape(s: Stroke, b: Box, H: number): boolean {
  const w = b.x1 - b.x0,
    h = b.y1 - b.y0;
  if (!(w > 0.5 * H && h > 0.5 * H && w < 1.8 * H && h < 1.8 * H && w / h > 0.6 && w / h < 1.7)) return false;
  const n = Math.floor(s.pts.length / 3);
  // a mano la casella spesso non si chiude del tutto
  const close = Math.hypot(s.pts[(n - 1) * 3] - s.pts[0], s.pts[(n - 1) * 3 + 1] - s.pts[1]) <= 0.8 * Math.max(w, h);
  if (!close || pathLen(s) < 1.6 * (w + h)) return false;
  return corners(s, 0.2 * Math.max(w, h)) >= 3;
}

/** Le caselle dei task: tratti a forma di casella con niente scritto subito a sinistra, sulla stessa riga. */
function taskBoxes(ink: Stroke[], H: number): Set<Stroke> {
  const bs = ink.map((s) => ({ s, b: box(s) }));
  const out = new Set<Stroke>();
  for (const { s, b } of bs) {
    if (!isBoxShape(s, b, H)) continue;
    const leftText = bs.some(
      ({ s: o, b: ob }) => o !== s && ob.x1 <= b.x0 + 0.2 * H && ob.x1 >= b.x0 - 2 * H && Math.min(ob.y1, b.y1) - Math.max(ob.y0, b.y0) > 0.3 * (b.y1 - b.y0) && ob.y1 - ob.y0 < 3 * H
    );
    if (!leftText) out.add(s);
  }
  return out;
}

/** Angoli netti del tratto (cambi di direzione oltre ~55°), misurati su pezzi lunghi `step`. */
function corners(s: Stroke, step: number): number {
  const pts: [number, number][] = [[s.pts[0], s.pts[1]]];
  for (let i = 3; i + 1 < s.pts.length; i += 3) {
    const last = pts[pts.length - 1];
    if (Math.hypot(s.pts[i] - last[0], s.pts[i + 1] - last[1]) >= step) pts.push([s.pts[i], s.pts[i + 1]]);
  }
  let n = 0;
  let prevTurn = false;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    const turn = d > (55 * Math.PI) / 180;
    if (turn && !prevTurn) n++;
    prevTurn = turn;
  }
  return n;
}

function strokeLen(s: Stroke): number {
  return pathLen(s);
}

/**
 * Cosa togliere dall'immagine per non far trascrivere il testo cancellato (solo inchiostro nuovo):
 * - i tratti attraversati da una cancellatura e le lettere vicinissime alla sua linea;
 * - le altre linee del tratteggio (parallele e vicine a una cancellatura sicura);
 * - le righe cancellate quasi per intero: se resta meno di un quarto dell'inchiostro, via anche il resto
 *   (i pezzi di parola rimasti fuori dalle linee). Una parola cancellata e riscritta accanto resta: la
 *   parola nuova è molto più di un quarto della riga.
 */
export function strikeErasure(strikes: Stroke[], allStrokes: Stroke[]): Stroke[] {
  if (!strikes.length) return [];
  const st = new Set(strikes);
  const ink = allStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 3 && !st.has(s));
  const boxes = new Map(ink.map((s) => [s, box(s)]));
  const bx = (s: Stroke) => boxes.get(s) ?? box(s);
  const H = Math.max(0.5, median([...boxes.values()].filter((b) => b.y1 - b.y0 > 0.3 && b.y1 - b.y0 < 4 && b.x1 - b.x0 < 4).map((b) => b.y1 - b.y0)) || 1.2);
  const erased = new Set<Stroke>(struckStrokes(strikes, allStrokes));
  // linee dritte del tratteggio rimaste nere
  const angle = (s: Stroke) => {
    const n = Math.floor(s.pts.length / 3);
    let a = (Math.atan2(s.pts[(n - 1) * 3 + 1] - s.pts[1], s.pts[(n - 1) * 3] - s.pts[0]) * 180) / Math.PI;
    if (a > 90) a -= 180;
    if (a < -90) a += 180;
    return a;
  };
  const lineLike = (o: Stroke) => {
    const b = bx(o);
    return b.x1 - b.x0 >= Math.max(2.5, 2.5 * H) && !isTick(o, H) && yReversals(o, 0.3 * H) / Math.max(1e-6, pathLen(o)) <= 0.15;
  };
  const keep = new Set(classifyLines(ink, allStrokes).filter((l) => l.kind !== "through").map((l) => l.stroke));
  const boxesT = taskBoxes(ink, H);
  const straight = strikes.filter((s) => yReversals(s, 0.3 * H) / Math.max(1e-6, pathLen(s)) <= 0.15);
  for (const o of ink) {
    if (erased.has(o) || keep.has(o) || !lineLike(o)) continue;
    const ob = bx(o);
    const ao = angle(o);
    const twin = straight.some((s) => {
      const sb = box(s);
      if (Math.min(sb.x1, ob.x1) - Math.max(sb.x0, ob.x0) < 0.3 * Math.min(sb.x1 - sb.x0, ob.x1 - ob.x0)) return false;
      const d = Math.abs(angle(s) - ao);
      if (Math.min(d, 180 - d) > 20) return false;
      let m = Infinity;
      for (let i = 0; i + 1 < o.pts.length; i += 6) m = Math.min(m, distToPath(s, o.pts[i], o.pts[i + 1]));
      return m < 2.5 * H;
    });
    if (twin) erased.add(o);
  }
  // righe quasi tutte cancellate
  const text = ink.filter((o) => !isDrawing(bx(o), H)).sort((p, q) => bx(p).y0 + bx(p).y1 - (bx(q).y0 + bx(q).y1));
  type Row = { cy: number; n: number; x0: number; x1: number; items: Stroke[] };
  const rows: Row[] = [];
  for (const o of text) {
    const b = bx(o);
    const cy = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => Math.abs(cy - r.cy) < 0.7 * H && b.x0 <= r.x1 + 4 * H && b.x1 >= r.x0 - 4 * H);
    if (row) {
      row.cy = (row.cy * row.n + cy) / (row.n + 1);
      row.n++;
      row.x0 = Math.min(row.x0, b.x0);
      row.x1 = Math.max(row.x1, b.x1);
      row.items.push(o);
    } else rows.push({ cy, n: 1, x0: b.x0, x1: b.x1, items: [o] });
  }
  // linee che cancellano: quelle sicure e le altre del tratteggio
  const lines = [...strikes, ...ink.filter((o) => erased.has(o) && lineLike(o))].map((s) => ({ s, b: box(s) }));
  const maxGap = 4 * H;
  for (const r of rows) {
    let total = 0,
      gone = 0;
    for (const o of r.items) {
      const L = Math.max(0.3, strokeLen(o));
      total += L;
      if (erased.has(o)) gone += L;
    }
    let whole = gone > 0 && gone >= 0.75 * total;
    // oppure: le linee percorrono la riga da un capo all'altro (anche passando sul fondo delle lettere)
    const w = r.x1 - r.x0;
    if (!whole && gone > 0 && w >= 2 * H && r.items.length >= 2) {
      const top = median(r.items.map((o) => bx(o).y0)),
        bottom = median(r.items.map((o) => bx(o).y1));
      const lo = top - 0.25 * H,
        hi = bottom + 0.5 * H;
      const near = lines.filter(({ b }) => b.y1 >= lo && b.y0 <= hi && b.x1 >= r.x0 && b.x0 <= r.x1);
      const xs: number[] = [];
      for (let x = r.x0; x <= r.x1; x += 0.2) if (near.some(({ s }) => ysAt(s, x).some((y) => y >= lo && y <= hi))) xs.push(x);
      const segs: [number, number][] = [];
      for (const x of xs) {
        const last = segs[segs.length - 1];
        if (last && x - last[1] <= maxGap) last[1] = x;
        else segs.push([x, x]);
      }
      let filled = 0;
      for (const sg of segs) {
        if (sg[0] - r.x0 <= maxGap) sg[0] = r.x0;
        if (r.x1 - sg[1] <= maxGap) sg[1] = r.x1;
        filled += sg[1] - sg[0];
      }
      whole = filled >= 0.85 * w;
    }
    // le caselle e le spunte restano: una casella vuota non diventa testo, e un task riscritto accanto resta un task
    if (whole) for (const o of r.items) if (!keep.has(o) && !boxesT.has(o)) erased.add(o);
  }
  // pezzetti rimasti in mezzo al testo cancellato (una sillaba, un'asta, una parola corta):
  // attorno a loro, sulla stessa riga, l'inchiostro cancellato è parecchio più di quello rimasto.
  // Le caselle e le spunte dei task restano (un task cancellato e riscritto accanto resta un task).
  for (let pass = 0; pass < 4; pass++) {
    const rest = text.filter((o) => !erased.has(o) && !keep.has(o));
    const add: Stroke[] = [];
    for (const o of rest) {
      const ob = bx(o);
      if (boxesT.has(o)) continue;
      const cx = (ob.x0 + ob.x1) / 2,
        cy = (ob.y0 + ob.y1) / 2;
      let gone = 0,
        left = 0;
      for (const q of text) {
        if (keep.has(q) || boxesT.has(q)) continue;
        const qb = bx(q);
        const qx = (qb.x0 + qb.x1) / 2,
          qy = (qb.y0 + qb.y1) / 2;
        if (Math.abs(qx - cx) > 5 * H || Math.abs(qy - cy) > 1.3 * H) continue;
        const L = Math.max(0.3, strokeLen(q));
        if (erased.has(q)) gone += L;
        else left += L;
      }
      if (DEBUG) DEBUG(o, { frag: 1, x: ob.x0, y: ob.y0, w: ob.x1 - ob.x0, h: ob.y1 - ob.y0, gone, left });
      if (gone >= 1.3 * left) add.push(o);
    }
    if (!add.length) break;
    for (const o of add) erased.add(o);
  }
  // caselle: restano solo se sulla loro riga, a destra, è rimasto del testo (un task riscritto accanto);
  // in quel caso resta anche la spunta dentro la casella. Una casella di un task tutto cancellato va via.
  for (const bxs of boxesT) {
    if (erased.has(bxs)) continue;
    const b = bx(bxs);
    const cy = (b.y0 + b.y1) / 2;
    const hasText = text.some((q) => {
      if (q === bxs || erased.has(q) || keep.has(q) || boxesT.has(q)) return false;
      const qb = bx(q);
      return Math.abs((qb.y0 + qb.y1) / 2 - cy) < 1.0 * H && qb.x0 > b.x1 - 0.2 * H && qb.x0 < b.x1 + 15 * H && strokeLen(q) > 0.8 * H;
    });
    const inBox = ink.filter((q) => {
      const qb = bx(q);
      return q !== bxs && qb.x1 - qb.x0 < 3 * H && qb.y1 - qb.y0 < 3 * H && qb.x0 < b.x1 + 0.3 * H && qb.x1 > b.x0 - 0.3 * H && qb.y0 < b.y1 + 0.3 * H && qb.y1 > b.y0 - 0.3 * H && qb.x0 < b.x1;
    });
    if (hasText) for (const q of inBox) erased.delete(q);
    else if (lines.some(({ b: lb }) => lb.y1 >= b.y0 - H && lb.y0 <= b.y1 + H) || [...erased].some((q) => q !== bxs && Math.abs((bx(q).y0 + bx(q).y1) / 2 - cy) < 1.0 * H)) {
      // solo se su quella riga c'è davvero una cancellatura: una forma chiusa da sola (una stellina, un disegno)
      // senza niente di cancellato vicino non è un task cancellato
      erased.add(bxs);
      for (const q of inBox) erased.add(q);
    }
  }
  return [...erased];
}

function distToPath(s: Stroke, x: number, y: number): number {
  let d = Infinity;
  for (let i = 3; i + 1 < s.pts.length; i += 3) {
    const ax = s.pts[i - 3],
      ay = s.pts[i - 2],
      bx = s.pts[i],
      by = s.pts[i + 1];
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)) : 0;
    d = Math.min(d, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return d;
}

/** Quante volte due tratti si incrociano. */
function intersections(a: Stroke, b: Stroke): number {
  let n = 0;
  for (let i = 3; i + 1 < a.pts.length; i += 3) {
    const ax = a.pts[i - 3],
      ay = a.pts[i - 2],
      bx_ = a.pts[i],
      by = a.pts[i + 1];
    for (let j = 3; j + 1 < b.pts.length; j += 3) {
      const cx = b.pts[j - 3],
        cy = b.pts[j - 2],
        dx = b.pts[j],
        dy = b.pts[j + 1];
      const den = (bx_ - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx_ - ax)) / den;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) n++;
    }
  }
  return n;
}

let DEBUG: ((s: Stroke, info: Record<string, number>) => void) | null = null;
/** Solo per le prove: riceve le misure di ogni tratto candidato. */
export function setStrikeDebug(f: typeof DEBUG): void {
  DEBUG = f;
}

/**
 * Tratti nuovi che CANCELLANO parole: linee lunghe (dritte, anche oblique) o scarabocchi che passano
 * a metà altezza di più lettere. Una sottolineatura (sotto le lettere) no: una linea che conta come cancellatura
 * incrocia parecchi tratti delle lettere lungo il suo percorso.
 */
export function findStrikes(newStrokes: Stroke[], allStrokes: Stroke[]): Stroke[] {
  const ink = allStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 6);
  const boxes = new Map(ink.map((s) => [s, box(s)]));
  const bx = (s: Stroke) => boxes.get(s) ?? box(s);
  // altezza tipica di una lettera (tratti piccoli)
  const H = Math.max(0.5, median(ink.map(bx).filter((b) => b.y1 - b.y0 > 0.3 && b.y1 - b.y0 < 4 && b.x1 - b.x0 < 4).map((b) => b.y1 - b.y0)) || 1.2);
  // candidati: tratti lunghi in orizzontale, non troppo alti, che non salgono e scendono come una parola in corsivo
  const candidates = newStrokes.filter((s) => {
    if (s.tip === 1 || s.pts.length < 6) return false;
    const b = bx(s);
    const w = b.x1 - b.x0;
    if (w < Math.max(2.5, 2.5 * H)) return false;
    if (isTick(s, H)) return false;
    const rev = yReversals(s, 0.3 * H) / Math.max(1e-6, pathLen(s));
    // linee dritte anche ripide (tratteggio obliquo), oppure tratti piatti non troppo alti
    if (rev <= 0.15) return b.y1 - b.y0 <= Math.max(6 * H, 0.9 * w);
    // scarabocchi sopra una parola: vanno su e giù come il corsivo, li riconosce poi il numero di incroci
    return b.y1 - b.y0 <= Math.max(5 * H, 0.7 * w);
  });
  if (!candidates.length) return [];
  const cand = new Set(candidates);
  // sottolineature già riconosciute: non sono cancellature
  const under = new Set(classifyLines(candidates, allStrokes).filter((l) => l.kind !== "through").map((l) => l.stroke));
  const isText = (o: Stroke) => {
    const ob = bx(o);
    const h = ob.y1 - ob.y0;
    return h > 0.25 && !isDrawing(ob, H);
  };
  // a ogni giro le parole lunghe in corsivo (scartate al primo giro perché "piatte") tornano lettere,
  // tranne quelle già riconosciute come cancellature
  let found = new Set<Stroke>();
  for (let pass = 0; pass < 4; pass++) {
    const text = ink.filter((o) => isText(o) && !found.has(o) && (pass > 0 || !cand.has(o)));
    const next = new Set<Stroke>();
    for (const s of candidates) {
      const b = bx(s);
      const isUnder = under.has(s);
      let crossings = 0;
      const partners = new Set<Stroke>();
      for (const o of text) {
        if (o === s) continue;
        const ob = bx(o);
        if (ob.x1 < b.x0 || ob.x0 > b.x1 || ob.y1 < b.y0 || ob.y0 > b.y1) continue;
        const c = intersections(s, o);
        if (c) {
          crossings += c;
          partners.add(o);
        }
      }
      const density = crossings / Math.max(1e-6, pathLen(s));
      if (DEBUG) DEBUG(s, { frac: density, inside: crossings, H, under: isUnder ? 1 : 0 });
      // una "sottolineatura" che attraversa molte lettere è in realtà una cancellatura (passa sul fondo delle parole)
      const rev = yReversals(s, 0.3 * H) / Math.max(1e-6, pathLen(s));
      const strike = isUnder
        ? (crossings >= 3 && density >= 0.3) || (partners.size >= 2 && crossings >= 5 && density >= 0.2)
        : rev > 0.35
          ? crossings >= 6 && density >= 0.5 // scarabocchio fitto sopra le lettere (una parola normale non incrocia quasi niente)
          : partners.size >= 2 && crossings >= 3 && density >= 0.25;
      if (strike) next.add(s);
    }
    const same = next.size === found.size && [...next].every((x) => found.has(x));
    found = next;
    if (same) break;
  }
  // tratteggio: linee dritte parallele e vicine a una cancellatura già sicura, che toccano almeno una lettera
  const angle = (s: Stroke) => {
    const n = Math.floor(s.pts.length / 3);
    let a = (Math.atan2(s.pts[(n - 1) * 3 + 1] - s.pts[1], s.pts[(n - 1) * 3] - s.pts[0]) * 180) / Math.PI;
    if (a > 90) a -= 180;
    if (a < -90) a += 180;
    return a;
  };
  const textAll = ink.filter((o) => isText(o));
  // linea alta di una DOPPIA sottolineatura che tocca il fondo delle lettere (p. es. sotto "Nicole"): non è una
  // cancellatura. C'è una linea gemella dritta subito sotto, e le lettere che tocca stanno quasi tutte SOPRA di lei
  // (una cancellatura passa a metà parola, con le lettere sopra e sotto).
  const meanY = (s: Stroke) => {
    let t = 0;
    let n = 0;
    for (let i = 1; i < s.pts.length; i += 3) {
      t += s.pts[i];
      n++;
    }
    return t / Math.max(1, n);
  };
  const straight = (s: Stroke) => yReversals(s, 0.3 * H) / Math.max(1e-6, pathLen(s)) <= 0.15;
  const doubleTop = (s: Stroke): boolean => {
    if (!straight(s)) return false;
    const sb = bx(s);
    const sw = sb.x1 - sb.x0;
    const sy = meanY(s);
    const as = angle(s);
    const twin = ink.some((u) => {
      if (u === s || found.has(u) || !straight(u)) return false;
      const ub = bx(u);
      const uw = ub.x1 - ub.x0;
      if (uw < 0.5 * sw || ub.y1 - ub.y0 > Math.max(1.5 * H, 0.25 * uw)) return false;
      if (Math.min(sb.x1, ub.x1) - Math.max(sb.x0, ub.x0) < 0.6 * Math.min(sw, uw)) return false;
      const d = Math.abs(angle(u) - as);
      if (Math.min(d, 180 - d) > 12) return false;
      const gap = meanY(u) - sy;
      return gap > 0.1 * H && gap < 2.2 * H;
    });
    if (!twin) return false;
    let above = 0;
    let all = 0;
    for (const o of textAll) {
      if (o === s || intersections(s, o) === 0) continue;
      const ob = bx(o);
      const h = Math.max(1e-6, ob.y1 - ob.y0);
      above += Math.min(1, Math.max(0, (sy - ob.y0) / h));
      all++;
    }
    return all > 0 && above / all >= 0.65;
  };
  for (const s of [...found]) if (doubleTop(s)) found.delete(s);
  for (let pass = 0; pass < 6; pass++) {
    let added = false;
    for (const c of candidates) {
      if (found.has(c) || under.has(c)) continue;
      if (yReversals(c, 0.3 * H) / Math.max(1e-6, pathLen(c)) > 0.15) continue;
      const cb = bx(c);
      const ac = angle(c);
      const twin = [...found].some((s) => {
        const sb = bx(s);
        if (Math.min(sb.x1, cb.x1) - Math.max(sb.x0, cb.x0) < 0.3 * Math.min(sb.x1 - sb.x0, cb.x1 - cb.x0)) return false;
        const d = Math.abs(angle(s) - ac);
        if (Math.min(d, 180 - d) > 20) return false;
        let m = Infinity;
        for (let i = 0; i + 1 < c.pts.length; i += 6) m = Math.min(m, distToPath(s, c.pts[i], c.pts[i + 1]));
        return m < 3 * H;
      });
      if (!twin) continue;
      const touches = textAll.some((o) => o !== c && !found.has(o) && intersections(c, o) > 0);
      if (touches) {
        found.add(c);
        added = true;
      }
    }
    if (!added) break;
  }
  const out = candidates.filter((s) => found.has(s) && !doubleTop(s));
  return out;
}

/** Solo la frase per Claude. */
export function lineHint(newStrokes: Stroke[], allStrokes: Stroke[]): string {
  return underlineReport(newStrokes, allStrokes).hint;
}

// ------------------------------------------------------------- frecce di risposta

export interface ReplyArrow {
  stroke: Stroke;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Frecce che collegano una riga a una scritta più sotto (risposta): tratti nuovi lunghi che scendono di almeno
 * una riga, passano nel margine (quasi senza toccare le lettere) e hanno scritta accanto a entrambi i capi.
 * L'inizio è il primo punto del tratto (si disegna dalla riga verso la risposta).
 */
export function findReplyArrows(newStrokes: Stroke[], allStrokes: Stroke[], exclude: Set<Stroke> = new Set()): ReplyArrow[] {
  const ink = allStrokes.filter((s) => s.tip !== 1 && s.pts.length >= 3);
  const boxes = new Map(ink.map((s) => [s, box(s)]));
  const bx = (s: Stroke) => boxes.get(s) ?? box(s);
  const H = Math.max(0.5, median(ink.map(bx).filter((b) => b.y1 - b.y0 > 0.3 && b.y1 - b.y0 < 4 && b.x1 - b.x0 < 4).map((b) => b.y1 - b.y0)) || 1.2);
  const text = ink.filter((o) => !exclude.has(o) && !isDrawing(bx(o), H) && bx(o).y1 - bx(o).y0 < 3 * H);
  // c'è scritta subito a destra del punto, alla stessa altezza?
  const textRight = (x: number, y: number, self: Stroke, above = 1.3) =>
    text.some((o) => {
      if (o === self) return false;
      const b = bx(o);
      return b.x0 >= x - 1.5 * H && b.x0 <= x + 5 * H && (b.y0 + b.y1) / 2 > y - above * H && (b.y0 + b.y1) / 2 < y + 1.3 * H;
    });
  const out: ReplyArrow[] = [];
  for (const s of newStrokes) {
    if (s.tip === 1 || s.pts.length < 6 || exclude.has(s)) continue;
    const b = bx(s);
    const n = Math.floor(s.pts.length / 3);
    const start = { x: s.pts[0], y: s.pts[1] };
    const end = { x: s.pts[(n - 1) * 3], y: s.pts[(n - 1) * 3 + 1] };
    const drop = end.y - start.y;
    const L = pathLen(s);
    // deve scendere di almeno due righe circa (una lettera alta come la «f» no)
    if (drop < 2 * H || (drop < 3 * H && L < 5 * H)) continue;
    if (b.y1 - b.y0 > 40 * H) continue;
    if (yReversals(s, 0.3 * H) / Math.max(1e-6, L) > 0.3) continue; // non una parola in corsivo
    let cross = 0;
    for (const o of text) {
      if (o === s) continue;
      const ob = bx(o);
      if (ob.x1 < b.x0 || ob.x0 > b.x1 || ob.y1 < b.y0 || ob.y0 > b.y1) continue;
      cross += intersections(s, o);
    }
    if (cross > 3 || cross / pathLen(s) > 0.15) continue; // passa nel margine, non sopra le parole
    // dentro o accanto a un disegno: è un tratto del disegno, non una freccia
    const drawingLike = (o: Stroke) => {
      const ob = bx(o);
      return isDrawing(ob, H) && (ob.x1 - ob.x0 > 4 * H || yReversals(o, 0.3 * H) / Math.max(1e-6, pathLen(o)) > 0.3);
    };
    if (ink.some((o) => o !== s && drawingLike(o) && !(bx(o).x1 < b.x0 - H || bx(o).x0 > b.x1 + H || bx(o).y1 < b.y0 - H || bx(o).y0 > b.y1 + H))) continue;
    // all'inizio la riga può stare anche un po' sopra (la freccia parte da sotto la casella)
    if (!textRight(start.x, start.y, s, 2.8) || !textRight(end.x, end.y, s)) continue;
    out.push({ stroke: s, start, end });
  }
  return out.sort((p, q) => p.start.y - q.start.y);
}
