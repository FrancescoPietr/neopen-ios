// Modello dati condiviso dal plugin.

/** Indirizzo univoco di una pagina Ncode. */
export interface PageKey {
  section: number;
  owner: number;
  note: number;
  page: number;
}

/** Un tratto di penna: dal momento in cui la punta tocca la carta a quando si alza. */
export interface Stroke {
  /** Timestamp (ms) del pen-down: serve anche a evitare duplicati. */
  t: number;
  /** 0 = penna normale, 1 = gomma. */
  tip: number;
  /** Colore grezzo inviato dalla penna (ARGB). */
  color: number;
  /** Punti appiattiti: [x, y, pressione, x, y, pressione, ...] in unità Ncode. */
  pts: number[];
  /** Momento (ms) in cui il tratto è stato trascritto; assente = non ancora trascritto. */
  tx?: number;
  /** Ricevuto in tempo reale: la penna non lo ha in memoria. */
  live?: boolean;
}

/** Una pagina del quaderno con i suoi tratti (letti dalla memoria della penna). */
export interface PageData {
  version: 1;
  key: PageKey;
  created: number;
  updated: number;
  strokes: Stroke[];
}

export type PenState = "disconnesso" | "ricerca" | "connessione" | "connesso" | "scaricamento";

export interface PenStatus {
  state: PenState;
  name?: string;
  battery?: number;
  usedMemory?: number;
  maxForce?: number;
}

export function pageId(k: PageKey): string {
  return `${k.section}_${k.owner}_${k.note}_${k.page}`;
}

export function sameKey(a: PageKey | null | undefined, b: PageKey | null | undefined): boolean {
  if (!a || !b) return false;
  return a.section === b.section && a.owner === b.owner && a.note === b.note && a.page === b.page;
}

/** Pagina valida: l'SDK usa -1 come "pagina non ancora nota". */
export function validKey(k: PageKey | null | undefined): k is PageKey {
  return !!k && k.section >= 0 && k.owner >= 0 && k.note >= 0 && k.page >= 0;
}

/** Rimuove i punti segnaposto (coordinate negative) lasciati dall'SDK. */
export function cleanPts(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    if (pts[i] >= 0 && pts[i + 1] >= 0) out.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  return out;
}
