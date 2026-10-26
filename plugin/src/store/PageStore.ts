// Pagine del quaderno lette dalla memoria della penna.
// La penna è l'archivio: qui i tratti restano solo in memoria (finché Obsidian è aperto).
// Su disco si salvano:
//   <cartella>/_pagine/<id>.json  i tratti della pagina (copia nel vault: la penna si può svuotare)
//   <cartella>/_pagine/<id>.svg   il disegno della pagina (incorporato nelle note)
//   nelle impostazioni, per ogni pagina: quanti tratti aveva e fin dove è stata trascritta.

import { App, TFile, normalizePath } from "obsidian";
import { groupToSvg, pageToSvg } from "../render/svg";
import { PageData, PageKey, Stroke, cleanPts, pageId, validKey } from "../types";

export interface StoreSettings {
  rootFolder: string;
}

/** Cosa ricorda il plugin di una pagina (non i tratti: quelli stanno nella penna). */
export interface PageIndexEntry {
  /** Numero di tratti che la penna dichiarava all'ultima lettura (-1 = sconosciuto, va riletta). */
  count: number;
  /** Orario (pen-down) dell'ultimo tratto trascritto: i tratti fino a qui sono già nel testo. */
  done: number;
  /** Ci sono tratti non ancora trascritti (es. trascrizione fallita): va riletta anche se invariata. */
  open?: boolean;
  /** Dimensione dei dati dichiarata dalla penna (seconda impronta, oltre al numero di tratti). */
  bytes?: number;
  /** Tratti dell'ultima copia arrivata dall'iPhone (app): la pagina ha tratti che la penna non ha in memoria. */
  relay?: number;
}

export class PageStore {
  private pages = new Map<string, PageData>();
  private dirty = new Set<string>();
  private flushTimer: number | null = null;
  private maxForce = 1023;
  private forceFromPen = false;

  constructor(
    private app: App,
    private settings: () => StoreSettings,
    private log: (m: string) => void,
    private onPageUpdated: (page: PageData) => void,
    /** Chiamata dopo aver aggiornato il disegno di una pagina (es. per creare la nota se la trascrizione è spenta). */
    private afterWrite: (page: PageData) => Promise<void> = async () => undefined,
    /** Pagine della stessa nota, in ordine (la prima è la radice). */
    private groupOf: (id: string) => string[] = (id) => [id],
    /** Indice delle pagine (salvato nelle impostazioni). */
    private index: () => Record<string, PageIndexEntry> = () => ({}),
    private saveIndex: () => Promise<void> = async () => undefined
  ) {}

  entry(key: PageKey): PageIndexEntry | undefined {
    return this.index()[pageId(key)];
  }

  /** La pagina va riletta dalla penna? (nuova, o con un numero di tratti diverso) */
  needsDownload(key: PageKey, count: number, bytes?: number): boolean {
    const e = this.entry(key);
    // 0 o sconosciuto: non ci si fida, si rilegge (le pagine piccole costano poco)
    if (!e || e.count <= 0 || count <= 0) return true;
    // i tratti non sono ancora salvati nel vault (pagine lette prima di questa funzione): si rileggono una volta
    if (!this.app.vault.getAbstractFileByPath(this.strokesPath(pageId(key)))) return true;
    if (e.count !== count) return true;
    return bytes !== undefined && bytes >= 0 && e.bytes !== bytes;
  }

  /** La copia dall'iPhone va presa? (diversa dall'ultima presa) */
  needsRelay(key: PageKey, count: number): boolean {
    const e = this.entry(key);
    return !e || e.relay !== count;
  }

  /** Pagina con tratti arrivati dall'iPhone (alcuni possono mancare nella memoria della penna). */
  hasRelay(key: PageKey): boolean {
    return (this.entry(key)?.relay ?? 0) > 0;
  }

  /** Pagina già letta dalla penna in questa sessione di Obsidian. */
  has(key: PageKey): boolean {
    return (this.pages.get(pageId(key))?.strokes.length ?? 0) > 0;
  }

  /** Ridisegna l'immagine unica di una nota con più pagine (salvata al posto di quella della prima pagina). */
  async writeGroup(anyId: string): Promise<void> {
    const ids = this.groupOf(anyId);
    if (ids.length < 2) return;
    if (ids.some((i) => !this.pages.has(i))) return; // servono tutte le pagine: si ridisegna alla prossima lettura
    const pages = ids.map((i) => this.pages.get(i)!);
    // altezza del foglio stimata da tutte le pagine dello stesso quaderno che conosciamo
    const note = pages[0].key.note;
    const all = [...this.pages.values()].filter((p) => p.key.note === note);
    let maxY = 0;
    for (const p of all) for (const st of p.strokes) for (let i = 1; i < st.pts.length; i += 3) maxY = Math.max(maxY, st.pts[i]);
    await this.writeFile(this.svgPath(ids[0]), groupToSvg(pages, { maxForce: this.maxForce, pageHeight: maxY + 3 }));
  }

  svgPath(id: string): string {
    const root = normalizePath(this.settings().rootFolder || "NeoPen");
    return normalizePath(`${root}/_pagine/${id}.svg`);
  }

  /** File con i tratti della pagina (la copia che resta nel vault anche se la penna viene svuotata). */
  strokesPath(id: string): string {
    const root = normalizePath(this.settings().rootFolder || "NeoPen");
    return normalizePath(`${root}/_pagine/${id}.json`);
  }

  /** Tratti salvati nel vault per questa pagina ([] se non c'è il file o non si legge). */
  private async readSaved(id: string): Promise<Stroke[]> {
    const path = this.strokesPath(id);
    try {
      if (!(await this.app.vault.adapter.exists(path))) return [];
      const data = JSON.parse(await this.app.vault.adapter.read(path));
      if (!this.forceFromPen && data?.maxForce > 0) this.maxForce = data.maxForce;
      const list = Array.isArray(data?.strokes) ? data.strokes : [];
      return list
        .filter((s: any) => s && Number.isFinite(s.t) && Array.isArray(s.pts) && s.pts.length >= 3)
        .map((s: any) => ({ ...s, tip: s.tip ?? 0, color: s.color ?? 0, pts: s.pts.map(Number) }));
    } catch (e) {
      this.log(`Tratti salvati di ${id} illeggibili: ${String(e)}`);
      return [];
    }
  }

  /** Salva i tratti della pagina nel vault (numeri arrotondati: file più piccolo, stesso disegno). */
  private async saveStrokes(page: PageData): Promise<void> {
    if (!page.strokes.length) return;
    const r = (v: number) => Math.round(v * 100) / 100;
    const body = {
      version: 1,
      maxForce: this.maxForce,
      key: page.key,
      created: page.created,
      updated: page.updated,
      strokes: page.strokes.map((s) => ({
        t: s.t,
        tip: s.tip,
        color: s.color,
        ...(s.tx ? { tx: s.tx } : {}),
        ...(s.live ? { live: true } : {}),
        pts: s.pts.map((v, i) => (i % 3 === 2 ? Math.round(v) : r(v))),
      })),
    };
    try {
      await this.writeFile(this.strokesPath(pageId(page.key)), JSON.stringify(body));
    } catch (e) {
      this.log(`Errore salvando i tratti ${pageId(page.key)}: ${String(e)}`);
    }
  }

  setMaxForce(v: number | undefined): void {
    if (v && v > 0) {
      this.maxForce = v;
      this.forceFromPen = true;
    }
  }

  private getPage(key: PageKey): PageData {
    const id = pageId(key);
    let page = this.pages.get(id);
    if (!page) {
      page = { version: 1, key, created: Date.now(), updated: Date.now(), strokes: [] };
      this.pages.set(id, page);
    }
    return page;
  }

  /** Pagina già in memoria (per la vista), senza crearla. */
  peek(key: PageKey): PageData | undefined {
    return this.pages.get(pageId(key));
  }

  async load(key: PageKey): Promise<PageData> {
    const id = pageId(key);
    if (!this.pages.get(id)?.strokes.length) {
      const saved = await this.readSaved(id);
      if (saved.length) {
        saved.sort((a, b) => a.t - b.t);
        this.pages.set(id, { version: 1, key, created: saved[0].t, updated: Date.now(), strokes: saved });
      }
    }
    return this.getPage(key);
  }

  /**
   * Pagina appena letta dalla penna (tutti i suoi tratti): sostituisce quella in memoria,
   * segna come già trascritti i tratti fino all'indice e ridisegna l'immagine.
   * Restituisce quanti tratti sono ancora da trascrivere.
   */
  async setFromPen(key: PageKey, count: number, strokes: Stroke[], bytes?: number, source: "pen" | "relay" = "pen"): Promise<number> {
    const id = pageId(key);
    const fromRelay = source === "relay";
    const clean = strokes
      .map((s) => ({ ...s, pts: cleanPts(s.pts), ...(fromRelay ? { live: true } : {}) }))
      .filter((s) => s.pts.length >= 3);
    const prev = this.pages.get(id);
    // tratti arrivati in tempo reale (la penna non li ha in memoria): li teniamo.
    // Dall'iPhone arriva la pagina intera: si unisce a quello che c'è già.
    const extra = (prev?.strokes ?? []).filter((s) => (fromRelay || s.live) && !clean.some((c) => c.t === s.t));
    // tratti salvati nel vault che la penna non ha più (pagina svuotata, poi riscritta): si tengono
    const known = new Set([...clean, ...extra].map((s) => s.t));
    const savedAll = await this.readSaved(id);
    const saved = savedAll.filter((s) => !known.has(s.t));
    const all = [...clean, ...extra, ...saved].sort((a, b) => a.t - b.t);
    // tratti già trascritti secondo il file della pagina (anche da un altro dispositivo, es. l'app del telefono:
    // il file viaggia insieme alle note): restano trascritti, così non finiscono due volte nella nota
    const txOf = new Map(savedAll.filter((s) => s.tx).map((s) => [s.t, s.tx]));
    for (const s of all) if (!s.tx && txOf.has(s.t)) s.tx = txOf.get(s.t);
    const idx = this.index();
    const e = idx[id] ?? { count: -1, done: 0 };
    for (const s of all) if (s.t <= e.done && !s.tx) s.tx = 1;
    const page: PageData = {
      version: 1,
      key,
      created: all[0]?.t || prev?.created || Date.now(),
      updated: Date.now(),
      strokes: all,
    };
    this.pages.set(id, page);
    const pending = all.filter((s) => !s.tx && s.tip !== 1).length;
    idx[id] = fromRelay
      ? { ...e, open: pending > 0, relay: count }
      : { count, done: e.done, open: pending > 0, ...(bytes !== undefined ? { bytes } : {}), ...(e.relay ? { relay: e.relay } : {}) };
    await this.saveIndex();
    if (all.length) {
      await this.saveStrokes(page);
      await this.writePage(page);
      this.onPageUpdated(page);
    }
    return pending;
  }

  /** Tratto ricevuto in tempo reale. */
  async addStroke(key: PageKey, stroke: Stroke): Promise<boolean> {
    if (!validKey(key)) return false;
    stroke = { ...stroke, pts: cleanPts(stroke.pts), live: true };
    if (stroke.pts.length < 3) return false;
    const page = this.getPage(key);
    const dup = page.strokes.some((s) => s.t === stroke.t && s.pts.length === stroke.pts.length);
    if (dup) return false;
    page.strokes.push(stroke);
    page.strokes.sort((a, b) => a.t - b.t);
    page.updated = Date.now();
    this.dirty.add(pageId(key));
    this.onPageUpdated(page);
    this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => void this.flush(), 1500);
  }

  /** Ridisegna le pagine cambiate dai tratti in tempo reale. */
  async flush(): Promise<void> {
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const page = this.pages.get(id);
      if (!page) continue;
      try {
        await this.saveStrokes(page);
        await this.writePage(page);
      } catch (e) {
        this.log(`Errore salvando il disegno ${id}: ${String(e)}`);
      }
    }
  }

  private async writePage(page: PageData): Promise<void> {
    const id = pageId(page.key);
    const group = this.groupOf(id);
    // la radice di una nota con più pagine ha l'immagine unica: non sovrascriverla con la pagina singola
    if (group.length < 2 || group[0] !== id) await this.writeFile(this.svgPath(id), pageToSvg(page, { maxForce: this.maxForce }));
    if (group.length > 1) await this.writeGroup(id);
    await this.afterWrite(page);
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (!dir) return;
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.createFolder(dir).catch(() => undefined);
    }
  }

  /** Scrive tramite l'API del vault, così gli embed ![[...svg]] si aggiornano. */
  private async writeFile(path: string, data: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, data);
      if (path.endsWith(".svg")) window.setTimeout(() => this.refreshImages(existing), 300);
    } else {
      await this.ensureFolder(path);
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, data);
      else await this.app.vault.create(path, data);
    }
  }

  /**
   * Obsidian tiene in cache le immagini già mostrate: dopo aver aggiornato il disegno
   * ricarichiamo le <img> che lo mostrano nelle note aperte, così si vede subito.
   */
  private refreshImages(file: TFile): void {
    const url = this.app.vault.getResourcePath(file);
    const base = url.split("?")[0];
    this.app.workspace.iterateAllLeaves((leaf) => {
      leaf.view.containerEl.querySelectorAll("img").forEach((img) => {
        if (img.src.split("?")[0] === base && img.src !== url) img.src = url;
      });
    });
  }

  /** Segna come trascritti i tratti con questi timestamp (e ricorda fin dove si è arrivati). */
  async markTranscribed(key: PageKey, strokeTimes: number[]): Promise<void> {
    const page = this.getPage(key);
    const set = new Set(strokeTimes);
    const now = Date.now();
    for (const s of page.strokes) if (set.has(s.t)) s.tx = now;
    const id = pageId(key);
    const idx = this.index();
    const e = idx[id] ?? { count: -1, done: 0 };
    idx[id] = {
      ...e,
      count: e.count,
      done: Math.max(e.done, ...strokeTimes),
      open: page.strokes.some((s) => !s.tx && s.tip !== 1),
    };
    await this.saveIndex();
    await this.saveStrokes(page);
  }

  async clearTranscribed(key: PageKey): Promise<void> {
    const page = this.getPage(key);
    for (const s of page.strokes) delete s.tx;
    const idx = this.index();
    const id = pageId(key);
    if (idx[id]) {
      idx[id].done = 0;
      idx[id].open = true;
    }
    await this.saveIndex();
    await this.saveStrokes(page);
  }

  /** Pagine in memoria con tratti non ancora trascritti. */
  pendingPages(): PageKey[] {
    return [...this.pages.values()]
      .filter((p) => p.strokes.some((s) => !s.tx && s.tip !== 1))
      .map((p) => p.key);
  }

  /**
   * Una volta sola, dalle versioni precedenti: ricava dall'archivio _dati fin dove
   * ogni pagina era già trascritta. I file in _dati non vengono toccati.
   */
  async importOldIndex(): Promise<number> {
    const root = normalizePath(`${this.settings().rootFolder || "NeoPen"}/_dati`);
    if (!(await this.app.vault.adapter.exists(root))) return 0;
    const list = await this.app.vault.adapter.list(root);
    const idx = this.index();
    let n = 0;
    for (const f of list.files.filter((p) => p.endsWith(".json"))) {
      try {
        const page = JSON.parse(await this.app.vault.adapter.read(f)) as PageData;
        if (!validKey(page?.key) || !Array.isArray(page.strokes)) continue;
        const id = pageId(page.key);
        const done = Math.max(0, ...page.strokes.filter((s) => s.tx).map((s) => s.t));
        if (!idx[id]) idx[id] = { count: -1, done };
        else idx[id].done = Math.max(idx[id].done, done);
        n++;
      } catch {
        /* file non valido: ignora */
      }
    }
    await this.saveIndex();
    return n;
  }
}

