// Dove va la scrittura nuova su una pagina già trascritta. Si guarda la geometria dei tratti, come farebbe chi legge:
//  - sulla stessa riga di parole già scritte (anche dopo, "mangia" → "mangia alle 23:00"; anche una casella disegnata
//    davanti) → cambia QUELLA riga;
//  - attaccata a una cancellatura (sopra, sotto o subito accanto) e non sulla riga di altre parole → prende il posto
//    delle parole cancellate, in quella riga;
//  - piccola, nello spazio subito sopra una riga e dentro la sua larghezza → è un'aggiunta in quella riga;
//  - una cancellatura su una riga senza niente di nuovo vicino → quella riga perde le parole cancellate (o sparisce);
//  - altrove (una riga nuova sotto, un margine lontano) → testo nuovo, come sempre.
// Ogni riga cambiata si rilegge da sola (un ritaglio con la riga in grigio, le aggiunte in nero, le cancellature in
// rosso): niente parole o orari spostati da una riga all'altra.

import { Stroke } from "../types";
import { B, bounds, letterHeight, writtenRows } from "./ticks";

export interface RowEdit {
  /** La riga già scritta (unità Ncode). */
  row: { y0: number; y1: number; yc: number; x0: number; x1: number };
  /** I suoi tratti già trascritti (in grigio nel ritaglio). */
  old: Stroke[];
  /** Le cancellature nuove su questa riga (in rosso). */
  strikes: Stroke[];
  /** La scrittura nuova che va in questa riga (in nero). */
  added: Stroke[];
  /** Perché: per il registro. */
  why: string[];
}

const ink = (s: Stroke) => s.tip !== 1 && s.pts.length >= 3;
const overlapX = (a: B, b: B, pad = 0) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1;

/** Gruppi di tratti vicini (una parola, un orario, una casella): si toccano o quasi. */
export function clusters(strokes: Stroke[], H: number): Stroke[][] {
  const groups: { b: B; s: Stroke[] }[] = [];
  for (const s of strokes) {
    const b = bounds([s]);
    const near = groups.filter((g) => b.x0 - 0.9 * H < g.b.x1 && g.b.x0 - 0.9 * H < b.x1 && b.y0 - 0.35 * H < g.b.y1 && g.b.y0 - 0.35 * H < b.y1);
    const merged = { b, s: [s] };
    for (const g of near) {
      merged.s.push(...g.s);
      merged.b = { x0: Math.min(merged.b.x0, g.b.x0), y0: Math.min(merged.b.y0, g.b.y0), x1: Math.max(merged.b.x1, g.b.x1), y1: Math.max(merged.b.y1, g.b.y1) };
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }
  return groups.map((g) => g.s);
}

/**
 * Le righe già scritte che la scrittura nuova cambia. `fresh` = tratti nuovi (senza spunte), `strikes` = quelli tra
 * loro che sono cancellature, `old` = tratti già trascritti. Quello che non va in nessuna riga resta testo nuovo.
 */
export function planRowEdits(fresh: Stroke[], strikes: Stroke[], old: Stroke[], all: Stroke[], boxes: B[] = []): RowEdit[] {
  const H = letterHeight(all.filter(ink));
  const oldInk = old.filter(ink);
  const rows = writtenRows(oldInk, all);
  if (!rows.length) return [];
  const edits = new Map<number, RowEdit>();
  const edit = (i: number, why: string): RowEdit => {
    let e = edits.get(i);
    if (!e) {
      const r = rows[i];
      const mine = oldInk.filter((s) => {
        const b = bounds([s]);
        const c = (b.y0 + b.y1) / 2;
        return Math.abs(c - r.yc) <= 0.75 * H && b.y1 - b.y0 < 3 * H;
      });
      e = { row: r, old: mine, strikes: [], added: [], why: [] };
      edits.set(i, e);
    }
    if (!e.why.includes(why)) e.why.push(why);
    return e;
  };
  const sameRow = (b: B) => {
    const c = (b.y0 + b.y1) / 2;
    let best = -1;
    let d = Infinity;
    rows.forEach((r, i) => {
      const dy = Math.abs(c - r.yc);
      // sulla riga (le code delle lettere non contano) e non lontana a destra, in un margine
      if (dy <= 0.6 * H && b.x0 <= r.x1 + 8 * H && b.x1 >= r.x0 - 3 * H && dy < d) {
        best = i;
        d = dy;
      }
    });
    return best;
  };

  // 1) cancellature sulle righe già scritte
  const struckRow = new Map<Stroke, number>();
  for (const s of strikes) {
    const b = bounds([s]);
    const c = (b.y0 + b.y1) / 2;
    const i = rows.findIndex((r) => Math.abs(c - r.yc) <= 0.8 * H && overlapX(b, r));
    if (i < 0) continue;
    edit(i, "cancellatura").strikes.push(s);
    struckRow.set(s, i);
  }

  // 2) la scrittura nuova, gruppo per gruppo
  const strikeSet = new Set(strikes);
  for (const g of clusters(fresh.filter((s) => ink(s) && !strikeSet.has(s)), H)) {
    const b = bounds(g);
    const c = (b.y0 + b.y1) / 2;
    // segni su una casella che c'è già (spunta, X, casella ripassata): sono spunte, non testo della riga
    if (boxes.some((x) => b.x0 < x.x1 + 0.4 * H && x.x0 - 0.4 * H < b.x1 && b.y0 < x.y1 + 0.6 * H && x.y0 - 1.2 * H < b.y1 && b.x1 < x.x1 + 2.5 * H)) continue;
    // una casella (anche già spuntata) disegnata all'inizio di una riga che non l'aveva: le spunte salgono sopra la
    // riga, quindi basta che stia a sinistra della prima parola, all'altezza della riga
    const start = rows.findIndex((r) => b.x1 <= r.x0 + 0.8 * H && b.x0 >= r.x0 - 4 * H && b.y1 >= r.yc - 0.5 * H && b.y0 <= r.yc + 0.8 * H && b.y1 - b.y0 < 4 * H);
    if (start >= 0) {
      edit(start, "casella all'inizio della riga").added.push(...g);
      continue;
    }
    // sulla riga di parole già scritte
    const r = sameRow(b);
    if (r >= 0) {
      edit(r, "scritta sulla stessa riga").added.push(...g);
      continue;
    }
    // attaccata a una cancellatura: la sostituisce
    let near = -1;
    let nd = Infinity;
    for (const [s, i] of struckRow) {
      const sb = bounds([s]);
      const sc = (sb.y0 + sb.y1) / 2;
      const dy = Math.abs(c - sc);
      // vicina (sopra, sotto o accanto), non più lunga di qualche volta la cancellatura e non all'inizio di una riga
      // nuova (quella comincia al margine sinistro, come le altre righe)
      const short = b.x1 - b.x0 <= Math.max(3 * (sb.x1 - sb.x0), 6 * H);
      const atMargin = b.x0 < rows[i].x0 + 1.5 * H;
      if (dy <= 2.6 * H && overlapX(b, sb, 2 * H) && short && !atMargin && dy < nd) {
        near = i;
        nd = dy;
      }
    }
    if (near >= 0) {
      edit(near, "correzione accanto alla cancellatura").added.push(...g);
      continue;
    }
    // piccola, nello spazio subito sopra una riga e dentro la sua larghezza: aggiunta in quella riga
    const small = b.y1 - b.y0 < 1.8 * H;
    const above = rows.findIndex((row) => c < row.yc - 0.6 * H && c > row.yc - 1.8 * H && b.x0 >= row.x0 - H && b.x1 <= row.x1 + 2 * H);
    if (small && above >= 0) {
      edit(above, "aggiunta sopra la riga").added.push(...g);
      continue;
    }
    // altrimenti: testo nuovo
  }
  return [...edits.values()];
}
