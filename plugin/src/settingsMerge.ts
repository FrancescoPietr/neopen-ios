// Le impostazioni del plugin (data.json) le scrivono più programmi: l'app sul telefono (che trascrive), Obsidian
// sull'iPhone e Obsidian sul PC (che hanno il plugin aperto). Ognuno ha una copia in memoria: se la salvasse così
// com'è, cancellerebbe quello che gli altri hanno scritto nel frattempo (le pagine trascritte, le loro note). Prima
// di salvare si fa un'unione a tre: si parte da quello che c'è sul disco e si rimettono solo le cose cambiate da
// noi rispetto all'ultima volta che l'abbiamo letto.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Unione a tre: `base` è quello che avevamo letto, `mine` la nostra copia (con le nostre modifiche), `disk` quello che
 * c'è ora sul disco (con le modifiche degli altri). Per una chiave che non abbiamo toccato vince il disco; per una
 * che abbiamo cambiato vinciamo noi. Gli elenchi per pagina (pageNotes, pageIndex…) si uniscono voce per voce.
 */
export function mergeSettings(base: Obj, mine: Obj, disk: Obj): Obj {
  const out: Obj = {};
  for (const k of new Set([...Object.keys(disk), ...Object.keys(mine)])) {
    const b = base[k];
    const m = mine[k];
    const d = disk[k];
    if (!(k in mine)) out[k] = d;
    else if (!(k in disk)) out[k] = m;
    else if (same(m, b)) out[k] = d;
    else if (isObj(m) && isObj(d) && isObj(b)) {
      const merged: Obj = { ...d };
      for (const e of new Set([...Object.keys(b), ...Object.keys(m)])) {
        if (same(m[e], b[e])) continue;
        if (m[e] === undefined) delete merged[e];
        else merged[e] = m[e];
      }
      out[k] = merged;
    } else out[k] = m;
  }
  return out;
}

/**
 * Mette `merged` dentro `target` senza cambiare gli oggetti degli elenchi (altre parti del plugin tengono un
 * riferimento a `settings.lineRows`, `settings.pageIndex`…).
 */
export function applyInPlace(target: Obj, merged: Obj): void {
  for (const k of Object.keys(merged)) {
    const t = target[k];
    const v = merged[k];
    if (isObj(t) && isObj(v)) {
      for (const e of Object.keys(t)) if (!(e in v)) delete t[e];
      Object.assign(t, v);
    } else target[k] = v;
  }
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? {}));
