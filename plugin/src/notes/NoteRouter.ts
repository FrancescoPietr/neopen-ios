// Decide in quale nota finisce ogni pagina del quaderno:
// - tag in cima alla pagina → regola (nota da template oppure nota del giorno);
// - freccia "→ N" → la pagina N continua nella stessa nota;
// - nessun tag → nota di base "Quaderno X - pagina Y".
// Ricorda la scelta (id pagina → percorso della nota) e la aggiorna se rinomini o sposti la nota.

import { App, TFile, TFolder, moment as obsidianMoment, normalizePath } from "obsidian";
import type { NeoPenSettings, TagRule } from "../settings";
import { PageKey, pageId } from "../types";
import {
  appendBlockAfterLast,
  blockStart,
  blockEnd,
  emptyBlock,
  hasBlock,
  insertUnderHeading,
  readBlock,
  removeBlock,
  splitBlockAt,
  stripLegacyPageSections,
  writeIntoBlock,
} from "../transcribe/noteBlock";

// moment esportato da Obsidian (il tipo del namespace non è "chiamabile" in TS: lo adattiamo)
const moment = obsidianMoment as unknown as (...args: any[]) => import("moment").Moment;

export interface PageInfo {
  /** Tag della prima riga (senza #), "" se assente. */
  pageTag?: string;
  /** Titolo scritto a mano in cima alla pagina (sottolineato o scritto come titolo). */
  title?: string;
  /** Prima riga di testo: usata come titolo se non ne è stato scritto uno. */
  firstLine?: string;
  /** Data della pagina (primo tratto). */
  created: number;
}

export interface RoutedNote {
  file: TFile;
  /** id del blocco della pagina nella nota. */
  blockId: string;
  kind: "note" | "daily";
}

export class NoteRouter {
  constructor(
    private app: App,
    private settings: () => NeoPenSettings,
    private save: () => Promise<void>,
    private svgPath: (id: string) => string,
    private log: (m: string) => void,
    /** Chiamata quando cambiano le pagine di una nota: va ridisegnata l'immagine unica. */
    private onGroupChanged: (rootId: string) => void = () => undefined
  ) {}

  /** Nota già assegnata alla pagina (o null). Riconosce anche le note create dalle versioni 0.2. */
  /** La nota sta nel cestino del plugin (non va mai riusata). */
  inBin(path: string): boolean {
    const bin = normalizePath(`${this.settings().rootFolder || "NeoPen"}/_cestino`) + "/";
    return path.startsWith(bin) || path.includes("/_cestino/");
  }

  /** Toglie i collegamenti a note finite nel cestino (versioni precedenti potevano lasciarli). */
  forgetBinned(): number {
    const refs = this.settings().pageNotes;
    let n = 0;
    for (const [id, ref] of Object.entries(refs)) {
      if (this.inBin(ref.path)) {
        delete refs[id];
        n++;
      }
    }
    return n;
  }

  get(key: PageKey): RoutedNote | null {
    const id = pageId(key);
    const ref = this.settings().pageNotes[id];
    if (ref && this.inBin(ref.path)) {
      delete this.settings().pageNotes[id]; // nota nel cestino: la pagina non ha più una nota
      void this.save();
    } else if (ref) {
      const f = this.app.vault.getAbstractFileByPath(ref.path);
      if (f instanceof TFile) return { file: f, blockId: id, kind: this.isDaily(f) ? "daily" : "note" };
    }
    // note delle versioni precedenti: frontmatter "neopen: <id>" (mai quelle nel cestino)
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.inBin(f.path)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm && String(fm.neopen) === id) {
        this.settings().pageNotes[id] = { path: f.path, drawing: true };
        void this.save();
        return { file: f, blockId: id, kind: "note" };
      }
    }
    return null;
  }

  /** Aggiorna i percorsi se una nota viene rinominata o spostata. */
  onRename(file: TFile, oldPath: string): void {
    let changed = false;
    const binned = this.inBin(file.path);
    for (const [id, ref] of Object.entries(this.settings().pageNotes)) {
      if (ref.path === oldPath) {
        // spostata nel cestino: la pagina non ha più una nota (non si riscrive nel cestino)
        if (binned) delete this.settings().pageNotes[id];
        else {
          ref.path = file.path;
          this.learnTitle(ref, file);
        }
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  /**
   * Hai rinominato una nota nata da un titolo scritto a mano: il nome nuovo è il titolo giusto.
   * Si ricorda la lettura sbagliata → titolo giusto, così le prossime letture (e "ritrascrivi da capo") lo usano.
   */
  private learnTitle(ref: { title?: string; path: string }, file: TFile): boolean {
    if (!ref.title || this.isDaily(file)) return false;
    const name = file.basename.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").replace(/\s+\d+$/, "").trim();
    const low = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!low(name) || low(name) === low(ref.title) || low(name) === low(sanitizeName(ref.title))) return false;
    const s = this.settings();
    s.titleFixes = s.titleFixes ?? {};
    s.titleFixes[low(ref.title)] = name;
    this.log(`Titolo corretto da te: «${ref.title}» → «${name}» (lo userò d'ora in poi).`);
    ref.title = name;
    return true;
  }

  // ------------------------------------------------------------- quaderni

  /** Cartella delle note di questo quaderno (dentro la cartella note); la prima volta la si registra. */
  notebookDir(key: PageKey, created: number): string {
    const s = this.settings();
    const base = normalizePath(s.notesFolder || s.rootFolder || "NeoPen");
    if (!s.notebookFolder?.trim()) return base;
    const nb = `${key.section}_${key.owner}_${key.note}`;
    s.notebooks = s.notebooks ?? {};
    if (!s.notebooks[nb]) {
      const start = moment(created).format("YYYY-MM-DD");
      s.notebooks[nb] = { start, path: normalizePath(`${base}/${this.notebookName(nb, start)}`) };
      void this.save();
      this.log(`Quaderno ${key.note}: le sue note vanno in "${s.notebooks[nb].path}".`);
    }
    return s.notebooks[nb].path;
  }

  notebookName(nb: string, start: string): string {
    const pattern = this.settings().notebookFolder || "Taccuino {{inizio}}";
    const d = moment(start, "YYYY-MM-DD");
    const name = pattern
      .replace(/\{\{\s*inizio\s*:\s*([^}]+?)\s*\}\}/g, (_m, f) => d.format(f))
      .replace(/\{\{\s*inizio\s*\}\}/g, d.format("DD-MM-YYYY"))
      .replace(/\{\{\s*quaderno\s*\}\}/g, nb.split("_").pop() ?? "");
    return sanitizeName(name) || `Quaderno ${nb.split("_").pop()}`;
  }

  /** Nuova data di inizio del quaderno: la sua cartella si rinomina (i link si aggiornano). */
  async setNotebookStart(nb: string, start: string): Promise<void> {
    const s = this.settings();
    const info = s.notebooks?.[nb];
    if (!info || info.start === start) return;
    info.start = start;
    const parent = info.path.split("/").slice(0, -1).join("/");
    const target = normalizePath(`${parent ? parent + "/" : ""}${this.notebookName(nb, start)}`);
    const folder = this.app.vault.getAbstractFileByPath(info.path);
    if (folder instanceof TFolder && target !== info.path && !this.app.vault.getAbstractFileByPath(target)) {
      await this.app.fileManager.renameFile(folder, target); // il rename aggiorna info.path
    } else if (!folder) info.path = target;
    await this.save();
  }

  /** Cartella rinominata o spostata: quaderni e note seguono. */
  onFolderRename(folder: TFolder, oldPath: string): void {
    const s = this.settings();
    let changed = false;
    for (const info of Object.values(s.notebooks ?? {})) {
      if (info.path === oldPath || info.path.startsWith(oldPath + "/")) {
        info.path = folder.path + info.path.slice(oldPath.length);
        changed = true;
      }
    }
    for (const ref of Object.values(s.pageNotes)) {
      if (ref.path.startsWith(oldPath + "/")) {
        ref.path = folder.path + ref.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  /**
   * Una volta sola (v0.13): le note fatte con la penna passano nella cartella del loro quaderno, senza la data
   * davanti al nome. Si spostano con Obsidian, quindi i link verso di loro si aggiornano. Le note del giorno restano.
   */
  async moveNotesToNotebooks(oldFolder: string, starts: Record<string, string>): Promise<number> {
    const s = this.settings();
    const old = normalizePath(oldFolder);
    s.notebooks = s.notebooks ?? {};
    const files = new Map<string, string>(); // percorso → id pagina
    for (const [id, ref] of Object.entries(s.pageNotes)) {
      const f = this.app.vault.getAbstractFileByPath(ref.path);
      if (!(f instanceof TFile) || this.inBin(f.path) || this.isDaily(f)) continue;
      if (f.parent?.path !== old) continue;
      if (!files.has(f.path)) files.set(f.path, id);
    }
    let moved = 0;
    for (const [path, id] of files) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      const [section, owner, note] = id.split("~")[0].split("_").map(Number);
      const nb = `${section}_${owner}_${note}`;
      if (!s.notebooks[nb] && starts[nb]) {
        const base = normalizePath(s.notesFolder || s.rootFolder || "NeoPen");
        s.notebooks[nb] = { start: starts[nb], path: normalizePath(`${base}/${this.notebookName(nb, starts[nb])}`) };
      }
      const dir = this.notebookDir({ section, owner, note, page: 0 }, f.stat.ctime);
      const name = f.basename.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim() || f.basename;
      const target = await this.freePath(dir, name, f.path);
      if (target === f.path) continue;
      await this.ensureFolder(target);
      await this.app.fileManager.renameFile(f, target);
      moved++;
    }
    await this.save();
    if (moved) this.log(`Spostate ${moved} note nelle cartelle dei quaderni (senza la data nel nome).`);
    return moved;
  }

  /** Note rinominate prima di questa versione: il loro nome diventa il titolo giusto. */
  async syncTitlesFromNames(): Promise<void> {
    let changed = false;
    for (const ref of Object.values(this.settings().pageNotes)) {
      const f = this.app.vault.getAbstractFileByPath(ref.path);
      if (f instanceof TFile && !this.inBin(f.path) && this.learnTitle(ref, f)) changed = true;
    }
    if (changed) await this.save();
  }

  /** Lettura del titolo già corretta da te una volta: si usa il titolo giusto. */
  fixTitle(title: string): string {
    const low = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return (title && this.settings().titleFixes?.[low(title)]) || title;
  }

  /**
   * Parte della pagina nella nota del giorno sbagliata (la pagina è stata scritta in più giorni):
   * il suo blocco passa nella nota del giorno in cui l'hai scritta.
   */
  async redate(seg: RoutedNote, created: number): Promise<RoutedNote> {
    if (seg.kind !== "daily") return seg;
    const cfg = this.dailyConfig();
    const want = moment(created).format(cfg.format);
    if (seg.file.basename === want) return seg;
    const s = this.settings();
    const ref = s.pageNotes[seg.blockId];
    if (!ref) return seg;
    const [section, owner, note, page] = seg.blockId.split("~")[0].split("_").map(Number);
    const key: PageKey = { section, owner, note, page };
    const rule = { ...(this.ruleFor("task") ?? ({} as TagRule)), drawing: false, calendar: ref.calendar } as TagRule;
    const text = readBlock(await this.app.vault.read(seg.file), seg.blockId);
    const oldFile = seg.file;
    delete s.pageNotes[seg.blockId];
    const routed = await this.ensureDaily(key, { pageTag: "", title: ref.title, created }, rule, seg.blockId);
    if (text) await this.app.vault.process(routed.file, (c) => writeIntoBlock(c, text, "replace", false, seg.blockId));
    await this.app.vault.process(oldFile, (c) => removeBlock(c, seg.blockId));
    s.pageNotes[seg.blockId] = { ...ref, path: routed.file.path };
    await this.save();
    this.log(`Pagina ${page}: questa parte è stata scritta il ${want}, quindi passa da "${oldFile.basename}" a "${routed.file.basename}".`);
    return routed;
  }

  /**
   * La pagina `from` ha una freccia verso la pagina numero `toPage` dello stesso quaderno.
   * Se la pagina di destinazione ha già una sua nota di base (ci hai scritto prima di disegnare
   * la freccia), le due note vengono unite.
   */
  async setContinuation(from: PageKey, toPage: number, fromBlock?: string): Promise<void> {
    if (toPage === from.page) return;
    const s = this.settings();
    // la freccia sta in una parte precisa della pagina (prima o dopo un titolo a metà pagina)
    const fid = fromBlock ?? pageId(from);
    const target: PageKey = { ...from, page: toPage };
    const tid = pageId(target);
    if (this.rootOf(tid) === this.rootOf(fid)) return; // già nella stessa nota
    if (this.chain(tid).includes(fid)) return; // eviterebbe un giro chiuso

    const targetRef = s.pageNotes[tid];
    if (targetRef) {
      // la pagina di destinazione ha già una nota: si può unire solo se è una nota di base con quella sola pagina
      if (!this.isSolo(target) || !this.isAuto(target)) {
        this.log(`La pagina ${toPage} ha già una sua nota (template, rinominata o con più pagine): non la unisco.`);
        return;
      }
      s.continuations[tid] = fid;
      await this.mergeInto(target, fid);
      return;
    }
    s.continuations[tid] = fid;
    await this.save();
    const where = this.noteOfBlock(fid)?.file.basename;
    this.log(`Freccia trovata: la pagina ${toPage} continuerà ${where ? `la nota "${where}"` : `la pagina ${from.page}`}.`);
  }

  /** Sposta la pagina `child` (con la sua nota di base) nella nota della pagina `parent`. */
  private async mergeInto(child: PageKey, parentBid: string): Promise<void> {
    const s = this.settings();
    const cid = pageId(child);
    const old = this.get(child);
    const parentNote = this.noteOfBlock(parentBid);
    if (!old || !parentNote) {
      await this.save();
      return;
    }
    let text = readBlock(await this.app.vault.read(old.file), cid);
    // il titolo scritto a mano della nota che sparisce non va perso: resta nel testo, in grassetto
    const oldTitle = s.pageNotes[cid]?.title;
    if (oldTitle && !text.includes(oldTitle)) text = `**${oldTitle}**${text ? "\n" + text : ""}`;
    const tags = (this.app.metadataCache.getFileCache(old.file)?.frontmatter?.tags ?? []) as string[] | string;
    delete s.pageNotes[cid];
    s.pageNotes[cid] = { path: parentNote.file.path, drawing: s.pageNotes[parentBid]?.drawing ?? true, calendar: s.pageNotes[parentBid]?.calendar };
    await this.placeBlock(parentNote, child);
    if (text) {
      await this.app.vault.process(parentNote.file, (c) => writeIntoBlock(c, text, "append", false, cid));
    }
    const extra = (Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/)).map(String).filter((t) => t && t !== "neopen");
    if (extra.length) {
      await this.app.fileManager.processFrontMatter(parentNote.file, (fm) => {
        const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
        fm.tags = [...new Set([...cur.filter(Boolean), ...extra])];
      });
    }
    const binned = await this.toBin(old.file);
    await this.save();
    this.onGroupChanged(this.rootOf(cid));
    this.log(`Freccia trovata dopo: la pagina ${child.page} è stata unita a "${parentNote.file.basename}" (la vecchia nota è in "${binned}").`);
  }

  /** Pagina radice della catena di continuazioni. */
  /** Nota che contiene il blocco indicato (pagina o parte di pagina "id~n"). */
  noteOfBlock(bid: string): RoutedNote | null {
    const ref = this.settings().pageNotes[bid];
    const f = ref ? this.app.vault.getAbstractFileByPath(ref.path) : null;
    if (f instanceof TFile) return { file: f, blockId: bid, kind: this.isDaily(f) ? "daily" : "note" };
    if (!bid.includes("~")) {
      const [section, owner, note, page] = bid.split("_").map(Number);
      return this.get({ section, owner, note, page });
    }
    return null;
  }

  /**
   * Pagine che condividono un'unica immagine (catena di frecce che parte da una pagina intera).
   * Se la catena parte da una parte di pagina (titolo a metà pagina), ogni pagina tiene la sua immagine.
   */
  imageGroup(id: string): string[] {
    const root = this.rootOf(id);
    if (root.includes("~")) return [id];
    return this.chain(id).filter((x) => !x.includes("~"));
  }

  /** Disegno da mostrare per la pagina (l'immagine unica della sua catena, o la sua). */
  svgFor(id: string): string {
    const g = this.imageGroup(id);
    return this.svgPath(g[0] ?? id);
  }

  rootOf(id: string): string {
    const seen = new Set<string>();
    let cur = id;
    while (this.settings().continuations[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = this.settings().continuations[cur];
    }
    return cur;
  }

  /** Pagine che finiscono nella stessa nota di `id`, nell'ordine della catena (radice → … → ultima). */
  chain(id: string): string[] {
    const cont = this.settings().continuations;
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      out.push(n);
      Object.keys(cont)
        .filter((k) => cont[k] === n)
        .sort((x, y) => Number(x.split("_")[3]) - Number(y.split("_")[3]))
        .forEach(visit);
    };
    visit(this.rootOf(id));
    return out;
  }

  /**
   * Mette il blocco (vuoto) della pagina nella nota del gruppo, subito dopo il blocco della
   * pagina che la precede nella catena: così il testo resta in ordine anche se scrivi dopo
   * sulla pagina precedente.
   */
  private async placeBlock(n: RoutedNote, key: PageKey): Promise<void> {
    const id = pageId(key);
    const order = this.chain(id);
    const before = order.slice(0, order.indexOf(id)).reverse();
    await this.app.vault.process(n.file, (c0) => {
      const c = stripLegacyPageSections(c0);
      if (hasBlock(c, id)) return c;
      for (const prev of before) {
        const endTag = blockEnd(prev);
        const at = c.indexOf(endTag);
        if (at >= 0) {
          const pos = at + endTag.length;
          return `${c.slice(0, pos)}\n${emptyBlock(id)}${c.slice(pos)}`;
        }
      }
      if (n.kind === "daily") return insertUnderHeading(c, "## Task", emptyBlock(id));
      return appendBlockAfterLast(c, id);
    });
  }

  /** Restituisce la nota della pagina, creandola (o aggiungendo la sezione) se serve. */
  async ensure(key: PageKey, info: PageInfo): Promise<RoutedNote> {
    const existing = this.get(key);
    if (existing) {
      await this.ensureBlock(existing, key);
      return existing;
    }
    const id = pageId(key);
    const s = this.settings();

    // una pagina che inizia con un titolo (doppia sottolineatura) è sempre una nota nuova, anche se c'era una freccia
    if (s.continuations[id] && info.title) {
      delete s.continuations[id];
      this.log(`Pagina ${key.page}: inizia con il titolo «${info.title}», quindi è una nota nuova (non continua la precedente).`);
    }
    // 1) continuazione di un'altra pagina (freccia → N): il blocco va subito dopo quello della parte
    //    della pagina in cui hai disegnato la freccia (con più titoli sulla stessa pagina, ognuno la sua)
    if (s.continuations[id]) {
      const parentBid = s.continuations[id];
      const rootNote = this.noteOfBlock(parentBid);
      if (rootNote) {
        const drawing = s.pageNotes[parentBid]?.drawing ?? true;
        await this.placeBlock(rootNote, key);
        s.pageNotes[id] = { path: rootNote.file.path, drawing, calendar: s.pageNotes[parentBid]?.calendar };
        await this.save();
        this.onGroupChanged(this.rootOf(id));
        this.log(`Pagina ${key.page} aggiunta a "${rootNote.file.basename}" (continuazione).`);
        return { file: rootNote.file, blockId: id, kind: rootNote.kind };
      }
    }

    // 2) regola del tag in cima alla pagina
    const rule = this.ruleFor(info.pageTag);
    if (rule?.action === "daily") return this.ensureDaily(key, info, rule);
    return this.ensureNote(key, info, rule);
  }

  // ------------------------------------------------------------- più note dalla stessa pagina

  /**
   * Una doppia sottolineatura a metà pagina apre una nota nuova: la pagina è divisa in "parti",
   * ognuna col suo blocco (id pagina, poi id~2, id~3…) nella sua nota. Restituisce gli id in ordine.
   */
  segmentIds(key: PageKey): string[] {
    const id = pageId(key);
    return this.settings().segments?.[id] ?? [id];
  }

  /** Le note delle parti della pagina, nell'ordine in cui stanno sul foglio. */
  segmentsOf(key: PageKey): RoutedNote[] {
    const out: RoutedNote[] = [];
    for (const bid of this.segmentIds(key)) {
      if (bid === pageId(key)) {
        const n = this.get(key);
        if (n) out.push(n);
        continue;
      }
      const ref = this.settings().pageNotes[bid];
      const f = ref ? this.app.vault.getAbstractFileByPath(ref.path) : null;
      if (f instanceof TFile) out.push({ file: f, blockId: bid, kind: this.isDaily(f) ? "daily" : "note" });
    }
    return out;
  }

  /** La parte in fondo alla pagina: lì va il testo nuovo. */
  lastSegment(key: PageKey): RoutedNote | null {
    const all = this.segmentsOf(key);
    return all.length ? all[all.length - 1] : null;
  }

  /** Nuova nota per un titolo con doppia sottolineatura a metà pagina (dopo la parte `after`). */
  async newSegment(key: PageKey, info: PageInfo, after?: string): Promise<RoutedNote> {
    const s = this.settings();
    const id = pageId(key);
    s.segments = s.segments ?? {};
    const list = s.segments[id] ?? [id];
    const n = Math.max(1, ...list.map((b) => Number(b.split("~")[1] ?? 1))) + 1;
    const bid = `${id}~${n}`;
    const rule = this.ruleFor(info.pageTag);
    const routed = rule?.action === "daily" ? await this.ensureDaily(key, info, rule, bid) : await this.ensureNote(key, info, rule, bid);
    const at = after ? list.indexOf(after) : -1;
    if (at >= 0) list.splice(at + 1, 0, bid);
    else list.push(bid);
    s.segments[id] = list;
    await this.save();
    this.log(`Titolo «${info.title}» (doppia sottolineatura): nuova nota "${routed.file.basename}".`);
    return routed;
  }

  /**
   * Una riga già trascritta è stata sottolineata due volte dopo: da lì in giù il testo
   * di quella parte passa in una nota nuova con quel titolo.
   */
  async splitAt(key: PageKey, line: string, created: number): Promise<RoutedNote | null> {
    for (const seg of this.segmentsOf(key)) {
      const content = await this.app.vault.read(seg.file);
      const r = splitBlockAt(content, line, seg.blockId);
      if (!r) continue;
      await this.app.vault.process(seg.file, (c) => splitBlockAt(c, line, seg.blockId)?.content ?? c);
      const routed = await this.newSegment(key, { title: r.title, created }, seg.blockId);
      if (r.rest) await this.app.vault.process(routed.file, (c) => writeIntoBlock(c, r.rest, "append", false, routed.blockId));
      return routed;
    }
    this.log(`Doppia sottolineatura sotto «${line}»: non trovo la riga nella nota.`);
    return null;
  }

  /**
   * Parte della pagina in cui sta una freccia: quella con il titolo indicato (titolo a metà pagina),
   * oppure la prima parte se il titolo è vuoto o è quello in cima alla pagina.
   */
  blockForTitle(key: PageKey, title: string): string {
    const ids = this.segmentIds(key);
    const n = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const want = n(title ?? "");
    if (!want) return ids[0];
    const hit = ids.find((bid) => n(this.settings().pageNotes[bid]?.title ?? "") === want);
    if (hit) return hit;
    const loose = ids.find((bid) => {
      const t = n(this.settings().pageNotes[bid]?.title ?? "");
      return t && (t.includes(want) || want.includes(t));
    });
    return loose ?? ids[ids.length - 1];
  }

  isContinuation(key: PageKey): boolean {
    return !!this.settings().continuations[pageId(key)];
  }

  /**
   * Una pagina che continuava un'altra nota ora inizia con un titolo (doppia sottolineatura):
   * esce da quella nota e diventa una nota sua, portando con sé il testo già trascritto.
   */
  async detach(key: PageKey, info: PageInfo): Promise<RoutedNote> {
    const s = this.settings();
    const id = pageId(key);
    const old = this.get(key);
    const oldRoot = this.rootOf(id);
    let carried = "";
    if (old) {
      carried = readBlock(await this.app.vault.read(old.file), id);
      await this.app.vault.process(old.file, (c) => removeBlock(c, id));
    }
    delete s.continuations[id];
    delete s.pageNotes[id];
    const routed = await this.ensure(key, info);
    if (carried.trim()) await this.app.vault.process(routed.file, (c) => writeIntoBlock(c, carried, "append", false, routed.blockId));
    await this.save();
    this.onGroupChanged(oldRoot);
    this.log(`Pagina ${key.page}: titolo «${info.title}», esce da "${old?.file.basename ?? "?"}" e diventa una nota nuova.`);
    return routed;
  }

  /**
   * Disegni della nota allineati alle pagine che contiene: per ogni pagina (con il disegno attivo)
   * una sola miniatura, quella giusta (l'immagine unica se la pagina fa parte di una catena);
   * via i doppioni e le miniature rimaste di pagine che non stanno più in questa nota;
   * aggiunte quelle che mancano, subito prima del testo della pagina. Restituisce quante modifiche ha fatto.
   */
  async tidyDrawings(file: TFile): Promise<number> {
    const original = await this.app.vault.read(file);
    // il disegno della pagina sta in un riquadro chiuso («Pagina N ▸», si apre con un clic):
    // qui si toglie il riquadro per sistemare le miniature, e alla fine lo si rimette
    const content = unwrapPageCallouts(original);
    const blocks = [...content.matchAll(/<!-- neopen:testo:(\d+_\d+_\d+_\d+(?:~\d+)?) -->/g)].map((m) => m[1]);
    const refs = this.settings().pageNotes;
    if (this.isDaily(file)) return 0;
    if (!blocks.some((b) => refs[b])) {
      // pagina non (ancora) registrata, per esempio una parte di pagina appena creata o scritta da un altro dispositivo:
      // le miniature non si toccano, ma il disegno resta comunque nel riquadro chiuso
      if (!blocks.length) return 0;
      const wrapped = wrapPageCallouts(content);
      if (wrapped === original) return 0;
      await this.app.vault.process(file, (c) => (c === original ? wrapped : c));
      return 1;
    }
    // disegno voluto → primo blocco a cui appartiene
    const wanted = new Map<string, string>();
    for (const b of blocks) {
      const ref = refs[b];
      if (!ref?.drawing) continue;
      const svg = this.svgFor(b.split("~")[0]);
      if (!wanted.has(svg)) wanted.set(svg, b);
    }
    let fixed = 0;
    const seen = new Set<string>();
    let out = content.replace(/^[ \t>]*!\[\[([^\]|\n]*_pagine\/\d+_\d+_\d+_\d+\.svg)(\|[^\]\n]*)?\]\][ \t]*\n?(\s*\n)?/gm, (m, path: string) => {
      const base = path.split("/").pop();
      const svg = [...wanted.keys()].find((w) => w.split("/").pop() === base);
      if (!svg || seen.has(svg)) {
        fixed++;
        return ""; // doppione, o disegno di una pagina che non sta in questa nota
      }
      seen.add(svg);
      return m;
    });
    for (const [svg, b] of wanted) {
      if (seen.has(svg)) continue;
      const at = out.indexOf(blockStart(b));
      if (at < 0) continue;
      out = `${out.slice(0, at)}![[${svg}]]\n\n${out.slice(at)}`;
      fixed++;
    }
    out = wrapPageCallouts(out);
    if (out === original) return 0;
    await this.app.vault.process(file, (c) => (c === original ? out : c));
    if (fixed) this.log(`Disegno sistemato in "${file.basename}" (una miniatura per pagina).`);
    return fixed || 1;
  }

  /** Il disegno della nota deve esserci, una volta sola (es. template senza {{disegno}}). */
  async ensureDrawing(n: RoutedNote, _key?: PageKey): Promise<void> {
    if (n.kind === "daily") return;
    await this.tidyDrawings(n.file);
  }

  /** Tag che decidono dove va una parte di pagina: quelli delle regole e i nomi dei template. */
  knownTags(): string[] {
    const fromTemplates = this.settings().autoTemplates === false ? [] : this.templateFiles().map((f) => normName(f.basename)).filter(Boolean);
    return [...new Set([...this.ruleTags(), ...fromTemplates])];
  }

  /** Tutti i tag che hanno una regola (non vanno mostrati nel testo). */
  ruleTags(): string[] {
    return this.settings().rules.flatMap((r) => r.tags);
  }

  /** La nota ha già questo titolo (nome o intestazione)? */
  hasTitle(key: PageKey, title: string): boolean {
    return this.settings().pageNotes[pageId(key)]?.title === title;
  }

  ruleFor(tag?: string): TagRule | undefined {
    if (!tag) return undefined;
    const t = tag.toLowerCase();
    return this.settings().rules.find((r) => r.tags.includes(t)) ?? this.autoRule(t);
  }

  // ------------------------------------------------------------- template (anche Templater)

  /** Cartelle dei template: quella di Templater e quella del plugin "Modelli" di Obsidian. */
  templateFolders(): string[] {
    const a = this.app as any;
    const out: string[] = [];
    const tpl = a.plugins?.plugins?.["templater-obsidian"]?.settings?.templates_folder;
    if (typeof tpl === "string" && tpl.trim()) out.push(normalizePath(tpl.trim()));
    try {
      const core = a.internalPlugins?.getPluginById?.("templates");
      const f = core?.enabled !== false ? core?.instance?.options?.folder : "";
      if (typeof f === "string" && f.trim()) out.push(normalizePath(f.trim()));
    } catch {
      /* ignora */
    }
    return [...new Set(out)];
  }

  /** Tutti i file template disponibili. */
  templateFiles(): TFile[] {
    const dirs = this.templateFolders();
    if (!dirs.length) return [];
    return this.app.vault.getMarkdownFiles().filter((f) => dirs.some((d) => f.path.startsWith(d + "/")));
  }

  /** Template con lo stesso nome del tag (es. #riunione → "Riunione.md" nella cartella dei template). */
  templateForTag(tag: string): TFile | undefined {
    const t = normName(tag);
    if (!t) return undefined;
    return this.templateFiles().find((f) => {
      const n = normName(f.basename);
      return n === t || n.replace(/^(template|templates|tpl|modello)/, "") === t;
    });
  }

  /** Senza una regola esplicita, un tag con un template omonimo usa quel template. */
  private autoRule(tag: string): TagRule | undefined {
    if (this.settings().autoTemplates === false) return undefined;
    const f = this.templateForTag(tag);
    if (!f) return undefined;
    return { tags: [tag], action: "note", template: f.path, folder: "", title: "", heading: "", drawing: true };
  }

  private templater(): { overwrite_file_commands?: (f: TFile) => Promise<void> } | null {
    const a = this.app as any;
    const p = a.plugins?.getPlugin?.("templater-obsidian") ?? a.plugins?.plugins?.["templater-obsidian"];
    return p?.templater ?? null;
  }

  /**
   * Crea la nota. Se il contenuto ha comandi di Templater (<% … %>) li fa eseguire a Templater.
   * Il file nasce con i comandi "nascosti", così l'eventuale "Trigger on new file creation" di
   * Templater non li esegue una seconda volta mentre ci lavoriamo; poi si rimettono e si esegue una volta sola.
   */
  private async createNote(path: string, body: string): Promise<TFile> {
    if (!body.includes("<%")) return this.app.vault.create(path, body);
    const tp = this.templater();
    if (!tp?.overwrite_file_commands) {
      this.log("Il template contiene comandi di Templater ma Templater non è attivo: li lascio così come sono.");
      return this.app.vault.create(path, body);
    }
    const file = await this.app.vault.create(path, body.split("<%").join(TP_HIDDEN));
    await new Promise((r) => window.setTimeout(r, 700)); // Templater reagisce ai file nuovi dopo ~300 ms
    await this.app.vault.process(file, (c) => c.split(TP_HIDDEN).join("<%"));
    try {
      await tp.overwrite_file_commands(file);
      this.log(`Template applicato con Templater in "${file.basename}".`);
    } catch (e) {
      this.log(`Templater ha dato un errore nel template: ${(e as Error)?.message ?? e}`);
    }
    // per sicurezza: nessun segnaposto deve restare nella nota
    await this.app.vault.process(file, (c) => (c.includes(TP_HIDDEN) ? c.split(TP_HIDDEN).join("<%") : c));
    return file;
  }

  /** Se la nota esiste ma il blocco della pagina no (es. cancellato a mano), lo ricrea. */
  private async ensureBlock(n: RoutedNote, key: PageKey): Promise<void> {
    const content = await this.app.vault.read(n.file);
    if (hasBlock(content, n.blockId)) return;
    // stesso posto in cui l'avrebbe messo una continuazione: dopo la pagina precedente, senza intestazioni
    await this.placeBlock(n, key);
    this.log(`Ricreato il blocco della pagina ${key.page} in "${n.file.basename}".`);
  }

  // ------------------------------------------------------------- nota da template

  private vars(key: PageKey, info: PageInfo, tag: string): Record<string, string> {
    const d = moment(info.created);
    return {
      date: d.format("YYYY-MM-DD"),
      time: d.format("HH:mm"),
      titolo: (info.title || info.firstLine || `Pagina ${key.page}`).slice(0, 80),
      tag,
      quaderno: String(key.note),
      pagina: String(key.page),
      id: pageId(key),
      iso: new Date(info.created).toISOString(),
    };
  }

  private fill(tpl: string, v: Record<string, string>, created: number): string {
    return tpl
      .replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/g, (_m, f) => moment(created).format(f))
      .replace(/\{\{\s*time\s*:\s*([^}]+?)\s*\}\}/g, (_m, f) => moment(created).format(f))
      .replace(/\{\{\s*title\s*\}\}/g, v.titolo)
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in v ? v[k] : m));
  }

  private async ensureNote(key: PageKey, info: PageInfo, rule?: TagRule, bid?: string): Promise<RoutedNote> {
    const s = this.settings();
    const pid = pageId(key);
    const id = bid ?? pid;
    const tag = rule ? info.pageTag ?? "" : "";
    const v = this.vars(key, info, tag);
    const folder = normalizePath((rule ? rule.folder : "") || this.notebookDir(key, info.created));
    // un titolo scritto a mano vince sul titolo di base "Quaderno X - pagina Y"
    const titlePattern = (rule ? rule.title : "") || (rule || info.title ? "{{titolo}}" : s.defaultTitle);
    const title = sanitizeName(this.fill(titlePattern, v, info.created)) || `Pagina ${key.page}`;
    const drawing = rule ? rule.drawing : true;

    const tplText = rule?.template ? await this.readTemplate(rule.template) : null;
    if (rule?.template && tplText === null) this.log(`Template "${rule.template}" non trovato: uso quello di base.`);
    // l'immagine della pagina sempre nel riquadro chiuso «Pagina N» (anche nelle note nate da un titolo a metà pagina)
    const body = wrapPageCallouts(this.buildBody(tplText, v, info.created, drawing ? `![[${this.svgFor(pid)}]]` : "", id, tag, info.title));

    const path = await this.freePath(folder, title);
    await this.ensureFolder(path);
    const file = await this.createNote(path, body);
    // la regola può essere automatica (template con lo stesso nome del tag)
    if (rule && !s.rules.includes(rule)) this.log(`Tag #${tag}: uso il template "${rule.template}".`);
    s.pageNotes[id] = { path: file.path, drawing, auto: !rule, title: info.title, calendar: rule?.calendar ?? false };
    await this.save();
    this.log(`Creata la nota "${file.path}"${tag ? ` (tag #${tag})` : ""}.`);
    return { file, blockId: id, kind: "note" };
  }

  // ------------------------------------------------------------- titolo o tag arrivati dopo

  /** Solo questa pagina finisce in quella nota (niente continuazioni o altre pagine). */
  private isSolo(key: PageKey): boolean {
    const id = pageId(key);
    const ref = this.settings().pageNotes[id];
    if (!ref) return false;
    return !Object.entries(this.settings().pageNotes).some(([other, r]) => other !== id && r.path === ref.path);
  }

  /**
   * La nota è ancora quella di base creata in automatico.
   * Per le note create dalle versioni precedenti (senza il segno "auto") vale se ha ancora il nome di base.
   */
  private isAuto(key: PageKey): boolean {
    const ref = this.settings().pageNotes[pageId(key)];
    if (!ref) return false;
    if (ref.auto !== undefined) return ref.auto;
    const base = sanitizeName(this.fill(this.settings().defaultTitle, this.vars(key, { created: Date.now() }, ""), Date.now()));
    const name = ref.path.split("/").pop()!.replace(/\.md$/, "");
    return name === base;
  }

  /** Il tag in cima è arrivato dopo: si può ancora spostare la pagina nella nota giusta? (`force` = ritrascrivi da capo) */
  canReroute(key: PageKey, tag: string, _force = false): boolean {
    // anche ritrascrivendo da capo: una nota già creata da un template (o rinominata a mano) non si ricrea
    return !!this.ruleFor(tag) && this.isSolo(key) && this.isAuto(key);
  }

  /** Il titolo è arrivato dopo: si può ancora rinominare la nota? (`force` = ritrascrivi da capo) */
  canRetitle(key: PageKey, title: string, force = false): boolean {
    const ref = this.settings().pageNotes[pageId(key)];
    // la nota del giorno ha il nome della data: un titolo scritto sulla pagina non la rinomina mai
    if (this.get(key)?.kind === "daily") return false;
    // "#task" in cima è il tag della pagina, non un titolo
    if (/^#/.test(title.trim())) return false;
    return !!title && ref?.title !== title && this.isSolo(key) && (force || this.isAuto(key));
  }

  /**
   * Riparazioni all'avvio (PC):
   *  - pagine che puntano a una nota sparita ma il cui blocco è in un'altra nota: si ricollegano;
   *  - pagine con «#tag» letto come titolo (es. "#task"), finite in una nota normale mentre il tag manda nella nota
   *    del giorno: si spostano lì (la vecchia nota va nel cestino).
   */
  async repairPages(): Promise<number> {
    const s = this.settings();
    let fixed = 0;
    // 1) ricollegare
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.inBin(f.path));
    for (const [id, ref] of Object.entries(s.pageNotes)) {
      if (this.app.vault.getAbstractFileByPath(ref.path) instanceof TFile) continue;
      for (const f of files) {
        if (!(await this.app.vault.cachedRead(f)).includes(`<!-- neopen:testo:${id} -->`)) continue;
        this.log(`Pagina ${id}: la nota "${ref.path}" non c'è più, il suo testo è in "${f.path}": ricollegata.`);
        ref.path = f.path;
        if (ref.title?.startsWith("#")) delete ref.title;
        fixed++;
        break;
      }
    }
    // 2) "#tag" preso per titolo
    for (const [id, ref] of Object.entries({ ...s.pageNotes })) {
      if (id.includes("~")) continue;
      const f = this.app.vault.getAbstractFileByPath(ref.path);
      if (!(f instanceof TFile) || this.isDaily(f) || this.inBin(f.path)) continue;
      const content = await this.app.vault.read(f);
      // il tag preso per titolo: nel titolo ricordato, oppure come intestazione "# #task" nella nota
      const m = /^#([\p{L}\p{N}_\-/]+)$/u.exec(ref.title ?? "") ?? /^# #([\p{L}\p{N}_\-/]+)\s*$/mu.exec(content);
      if (!m) continue;
      const tag = m[1].toLowerCase();
      if (this.ruleFor(tag)?.action !== "daily") continue;
      const [section, owner, note, page] = id.split("_").map(Number);
      const key: PageKey = { section, owner, note, page };
      if (!this.isSolo(key)) continue;
      const made = /^creato:\s*(\S+)/m.exec(content)?.[1];
      const created = made && !isNaN(Date.parse(made)) ? Date.parse(made) : f.stat.ctime;
      const carried = readBlock(content, id);
      await this.reroute(key, { pageTag: tag, created }, carried);
      this.log(`Pagina ${page}: «#${tag}» era stato preso per un titolo; spostata nella nota del giorno.`);
      fixed++;
    }
    if (fixed) await this.save();
    return fixed;
  }

  /**
   * Note del giorno rinominate per sbaglio col titolo della pagina (es. "Daily/task.md"): tornano al nome della data
   * (dalla proprietà date), senza l'intestazione col titolo. Restituisce quante ne ha sistemate.
   */
  async repairDailyNames(): Promise<number> {
    const { folder, format } = this.dailyConfig();
    if (!folder) return 0;
    const refs = this.settings().pageNotes;
    let fixed = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(normalizePath(folder) + "/") || this.isDaily(f)) continue;
      const mine = Object.values(refs).filter((r) => r.path === f.path);
      if (!mine.length) continue;
      const c = await this.app.vault.read(f);
      const d = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(c);
      if (!d) continue;
      const target = normalizePath(`${folder}/${moment(d[1], "YYYY-MM-DD").format(format)}.md`);
      if (this.app.vault.getAbstractFileByPath(target)) {
        this.log(`"${f.path}" dovrebbe chiamarsi "${target}", ma esiste già: la lascio com'è, uniscile tu.`);
        continue;
      }
      const titles = mine.map((r) => r.title).filter((t): t is string => !!t);
      await this.app.vault.process(f, (text) => {
        let out = text;
        for (const t of titles) out = out.replace(`\n# ${t}\n`, "\n");
        return out;
      });
      for (const r of mine) delete r.title;
      await this.app.fileManager.renameFile(f, target);
      fixed++;
      this.log(`Nota del giorno "${f.basename}" rinominata "${target.split("/").pop()}" (aveva preso il titolo della pagina).`);
    }
    if (fixed) await this.save();
    return fixed;
  }

  /**
   * Sposta la pagina dalla nota di base a quella prevista dal tag (template o nota del giorno),
   * portando con sé il testo già trascritto. La vecchia nota va nel cestino (recuperabile).
   */
  async reroute(key: PageKey, info: PageInfo, carriedText: string): Promise<RoutedNote> {
    const id = pageId(key);
    const s = this.settings();
    const old = this.get(key);
    const oldTitle = s.pageNotes[id]?.title;
    // la vecchia nota non deve essere ritrovata come "nota della pagina" (frontmatter neopen: <id>): altrimenti
    // ensure() la restituirebbe di nuovo e il testo verrebbe aggiunto a sé stesso
    if (old) {
      await this.app.vault.process(old.file, (c) => c.replace(new RegExp(`^neopen:\\s*"?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`, "m"), "neopen-spostata: true"));
      await new Promise((r) => window.setTimeout(r, 300)); // la cache del frontmatter si aggiorna
    }
    delete s.pageNotes[id];
    const routed = await this.ensure(key, { ...info, title: info.title || oldTitle });
    if (old && routed.file.path === old.file.path) {
      this.log(`Pagina ${key.page}: non riesco a spostarla (la nota trovata è la stessa), la lascio dov'è.`);
      return routed;
    }
    if (carriedText.trim()) {
      // righe ripetute identiche (doppioni lasciati da un errore): una sola
      const seen = new Set<string>();
      const lines = carriedText.split("\n").filter((l) => {
        if (!/^\s*- \[[ xX]\] /.test(l)) return true;
        if (seen.has(l.trim())) return false;
        seen.add(l.trim());
        return true;
      });
      carriedText = lines.join("\n");
      const already = readBlock(await this.app.vault.read(routed.file), routed.blockId).split("\n").map((l) => l.trim());
      carriedText = carriedText
        .split("\n")
        .filter((l) => !l.trim() || !already.includes(l.trim()))
        .join("\n");
    }
    if (carriedText.trim()) {
      await this.app.vault.process(routed.file, (c) => writeIntoBlock(c, carriedText, "append", false, routed.blockId));
    }
    if (old && old.file.path !== routed.file.path) {
      const oldName = old.file.basename;
      const binned = await this.toBin(old.file);
      await this.dropNumberSuffix(routed.file, oldName);
      this.log(`Pagina ${key.page} spostata in "${routed.file.basename}" (tag #${info.pageTag}); la vecchia nota è in "${binned}".`);
    }
    return routed;
  }

  /**
   * Parte della pagina (anche a metà pagina) con questo titolo, cercata in modo stretto: "" se nessuna.
   * (blockForTitle invece ripiega sull'ultima parte, che va bene per le frecce ma non per i tag.)
   */
  segmentWithTitle(key: PageKey, title: string): string {
    const n = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const want = n(title ?? "");
    if (!want) return "";
    const ids = this.segmentIds(key);
    const titleOf = (bid: string) => n(this.settings().pageNotes[bid]?.title ?? "");
    return (
      ids.find((bid) => titleOf(bid) === want) ??
      ids.find((bid) => {
        const t = titleOf(bid);
        return !!t && (t.includes(want) || want.includes(t));
      }) ??
      ""
    );
  }

  /** Titolo scritto a mano della parte (o pagina) indicata, "" se non c'è. */
  titleOf(bid: string): string {
    return this.settings().pageNotes[bid]?.title ?? "";
  }

  /** Titoli già noti delle parti di questa pagina (per dirli al modello). */
  segmentTitles(key: PageKey): string[] {
    return this.segmentIds(key)
      .map((bid) => this.settings().pageNotes[bid]?.title ?? "")
      .filter((t): t is string => !!t);
  }

  /**
   * Il #tag del template è arrivato dopo che la nota della parte era già stata creata senza template:
   * si ricrea la nota col template, portando tutto il testo trascritto (anche delle pagine che continuano lì).
   * La vecchia nota va nel cestino. Restituisce la nota nuova, o null se non si può (nota già con un template, ecc.).
   */
  async retemplate(bid: string, tag: string, created: number): Promise<RoutedNote | null> {
    const s = this.settings();
    const ref = s.pageNotes[bid];
    const rule = this.ruleFor(tag);
    if (!ref || !rule) return null;
    // solo le note create senza template (quelle col template, o rinominate a mano, non si toccano)
    if (ref.auto !== true) return null;
    if (rule.action === "daily") return this.toDaily(bid, tag, created);
    const old = this.app.vault.getAbstractFileByPath(ref.path);
    if (!(old instanceof TFile) || this.inBin(old.path)) return null;
    const content = await this.app.vault.read(old);
    const first = content.indexOf("<!-- neopen:testo:");
    const lastEnd = content.lastIndexOf("<!-- /neopen:testo:");
    const close = lastEnd >= 0 ? content.indexOf("-->", lastEnd) : -1;
    const region = first >= 0 && close > first ? content.slice(first, close + 3) : "";
    const [section, owner, note, page] = bid.split("~")[0].split("_").map(Number);
    const key: PageKey = { section, owner, note, page };
    const oldPath = old.path;
    delete s.pageNotes[bid];
    const routed = await this.ensureNote(key, { pageTag: tag, title: ref.title, firstLine: ref.title, created }, rule, bid);
    // il blocco vuoto del template prende il posto di tutto il testo della vecchia nota
    if (region) {
      await this.app.vault.process(routed.file, (c) => {
        const empty = emptyBlock(bid);
        return c.includes(empty) ? c.replace(empty, region) : c;
      });
    }
    s.pageNotes[bid] = { ...s.pageNotes[bid], title: ref.title, calendar: ref.calendar ?? s.pageNotes[bid]?.calendar };
    for (const r of Object.values(s.pageNotes)) if (r.path === oldPath) r.path = routed.file.path;
    await this.save();
    const oldName = old.basename;
    const binned = await this.toBin(old);
    await this.dropNumberSuffix(routed.file, oldName);
    await this.tidyDrawings(routed.file);
    this.log(`Tag #${tag} per «${ref.title ?? bid}»: nota ricreata col template in "${routed.file.basename}"; la vecchia è in "${binned}".`);
    return routed;
  }

  /**
   * Una parte di pagina finita in una nota di base, ma con #task (regola "nota del giorno") scritto accanto
   * al titolo: il suo testo passa nella nota del giorno. La vecchia nota va nel cestino se resta vuota.
   */
  private async toDaily(bid: string, tag: string, created: number): Promise<RoutedNote | null> {
    const s = this.settings();
    const ref = s.pageNotes[bid];
    const rule = this.ruleFor(tag);
    if (!ref || !rule) return null;
    const old = this.app.vault.getAbstractFileByPath(ref.path);
    if (!(old instanceof TFile) || this.inBin(old.path)) return null;
    const text = readBlock(await this.app.vault.read(old), bid);
    const [section, owner, note, page] = bid.split("~")[0].split("_").map(Number);
    const key: PageKey = { section, owner, note, page };
    delete s.pageNotes[bid];
    const routed = await this.ensureDaily(key, { pageTag: tag, title: ref.title, created }, rule, bid);
    const label = ref.title && !text.includes(`**${ref.title}**`) ? `**${ref.title}**` : "";
    const body = [label, text].filter(Boolean).join("\n");
    if (body) await this.app.vault.process(routed.file, (c) => writeIntoBlock(c, body, "replace", false, bid));
    await this.app.vault.process(old, (c) => removeBlock(c, bid));
    const others = Object.values(s.pageNotes).some((r) => r.path === old.path);
    await this.save();
    if (!others) {
      const binned = await this.toBin(old);
      this.log(`Tag #${tag} per «${ref.title ?? bid}»: spostato nella nota del giorno "${routed.file.basename}"; la vecchia nota è in "${binned}".`);
    } else this.log(`Tag #${tag} per «${ref.title ?? bid}»: spostato nella nota del giorno "${routed.file.basename}".`);
    return routed;
  }

  /** Rinomina la nota di base col titolo scritto a mano e lo mette come intestazione. */
  async retitle(key: PageKey, title: string): Promise<void> {
    const id = pageId(key);
    const ref = this.settings().pageNotes[id];
    const n = this.get(key);
    if (!n || !ref || n.kind === "daily") return;
    const clean = sanitizeName(title);
    const folder = n.file.path.split("/").slice(0, -1).join("/");
    const target = await this.freePath(folder, clean, n.file.path);
    await this.app.vault.process(n.file, (c) => {
      const prev = ref.title ? `\n# ${ref.title}\n` : null;
      if (prev && c.includes(prev)) return c.replace(prev, `\n# ${title}\n`);
      // dopo il frontmatter
      const m = c.match(/^---\n[\s\S]*?\n---\n/);
      return m ? `${m[0]}\n# ${title}\n${c.slice(m[0].length)}` : `# ${title}\n\n${c}`;
    });
    if (target !== n.file.path) await this.app.fileManager.renameFile(n.file, target);
    ref.title = title;
    await this.save();
    this.log(`Titolo "${title}": nota rinominata.`);
  }

  private buildBody(
    tpl: string | null,
    v: Record<string, string>,
    created: number,
    drawing: string,
    id: string,
    tag: string,
    title?: string
  ): string {
    const block = emptyBlock(id);
    if (tpl === null) {
      const tags = ["neopen", ...(tag ? [tag] : [])].join(", ");
      return `---
neopen: "${id}"
quaderno: ${v.quaderno}
pagina: ${v.pagina}
creato: ${v.iso}
tags: [${tags}]
---
${title ? `\n# ${title}\n` : ""}${drawing ? `\n${drawing}\n` : ""}
## Testo

${block}
`;
    }
    // il template non dice dove va il disegno: lo mettiamo subito prima del testo trascritto
    const head = drawing && !/\{\{\s*disegno\s*\}\}/.test(tpl) ? `${drawing}\n\n` : "";
    let out = this.fill(tpl, { ...v, disegno: drawing }, created);
    if (/\{\{\s*testo\s*\}\}/.test(out)) out = out.replace(/\{\{\s*testo\s*\}\}/, `${head}${block}`);
    else out = `${out.replace(/\s*$/, "")}\n\n${head}## Testo\n\n${block}\n`;
    return out;
  }

  /** Legge un template dal percorso, oppure per nome dalla cartella dei template (es. "Riunione"). */
  private async readTemplate(path: string): Promise<string | null> {
    const p = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
    let f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) {
      const name = p.split("/").pop()!.replace(/\.md$/, "").toLowerCase();
      const files = this.templateFiles();
      f = files.find((x) => x.path.toLowerCase().endsWith("/" + p.toLowerCase())) ?? files.find((x) => x.basename.toLowerCase() === name) ?? null;
    }
    return f instanceof TFile ? this.app.vault.read(f) : null;
  }

  // ------------------------------------------------------------- nota del giorno

  private dailyConfig(): { folder: string; format: string; template: string } {
    const opts = (this.app as any).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options ?? {};
    return { folder: opts.folder ?? "", format: opts.format || "YYYY-MM-DD", template: opts.template ?? "" };
  }

  /** Data della nota del giorno (YYYY-MM-DD), o null se non è una nota del giorno. */
  dailyDate(f: TFile): string | null {
    if (!this.isDaily(f)) return null;
    return moment(f.basename, this.dailyConfig().format, true).format("YYYY-MM-DD");
  }

  /** Le pagine di questa nota i cui task vanno nel calendario. */
  calendarScope(f: TFile, ids: string[], everywhere: boolean): string[] {
    const refs = this.settings().pageNotes;
    return ids.filter((id) => {
      if (everywhere) return true;
      const ref = refs[id];
      if (!ref || ref.path !== f.path) return false;
      return ref.calendar ?? this.isDaily(f);
    });
  }

  isDaily(f: TFile): boolean {
    const { folder, format } = this.dailyConfig();
    const inFolder = !folder || f.path.startsWith(normalizePath(folder) + "/");
    return inFolder && moment(f.basename, format, true).isValid();
  }

  private async ensureDaily(key: PageKey, info: PageInfo, rule: TagRule, bid?: string): Promise<RoutedNote> {
    const s = this.settings();
    const id = bid ?? pageId(key);
    const cfg = this.dailyConfig();
    const name = moment(info.created).format(cfg.format);
    const path = normalizePath(`${cfg.folder ? cfg.folder + "/" : ""}${name}.md`);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const tpl = cfg.template ? await this.readTemplate(cfg.template) : null;
      const v = this.vars(key, info, info.pageTag ?? "");
      const body = tpl !== null ? this.fill(tpl, { ...v, title: name }, info.created) : "";
      await this.ensureFolder(path);
      file = await this.createNote(path, body);
      this.log(`Creata la nota del giorno "${path}".`);
    }
    const f = file as TFile;
    const heading = rule.heading || "## Task";
    const drawing = rule.drawing ? `![[${this.svgFor(pageId(key))}]]\n\n` : "";
    await this.app.vault.process(f, (c) =>
      hasBlock(c, id) ? c : insertUnderHeading(c, heading, `${drawing}${emptyBlock(id)}`)
    );
    s.pageNotes[id] = { path: f.path, drawing: rule.drawing, calendar: rule.calendar ?? true };
    await this.save();
    this.log(`Pagina ${key.page} collegata alla nota del giorno "${f.basename}" (sezione ${heading}).`);
    return { file: f, blockId: id, kind: "daily" };
  }

  // ------------------------------------------------------------- utilità

  /** Sposta una nota sostituita nel cestino del plugin (dentro il vault, sempre recuperabile). */
  /** Copia di sicurezza della nota nel cestino (es. prima di ritrascrivere da capo). */
  async backup(file: TFile, why: string): Promise<string> {
    const s = this.settings();
    const bin = normalizePath(`${s.rootFolder || "NeoPen"}/_cestino`);
    if (!(await this.app.vault.adapter.exists(bin))) await this.app.vault.createFolder(bin).catch(() => undefined);
    const stamp = moment().format("YYYY-MM-DD HH-mm");
    const target = await this.freePath(bin, sanitizeName(`${file.basename} (${why} ${stamp})`));
    // la copia non deve essere riconosciuta come nota di una pagina
    const content = (await this.app.vault.read(file)).replace(/^neopen:.*$/m, "neopen-copia: true");
    await this.app.vault.create(target, content);
    return target;
  }

  /** "Nota 2.md" nata mentre la vecchia "Nota.md" esisteva ancora: tolta la vecchia, riprende il nome giusto. */
  private async dropNumberSuffix(file: TFile, oldName: string): Promise<void> {
    const m = /^(.*) (\d+)$/.exec(file.basename);
    if (!m || m[1] !== oldName) return;
    const folder = file.path.split("/").slice(0, -1).join("/");
    const target = normalizePath(`${folder ? folder + "/" : ""}${m[1]}.md`);
    if (this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(file, target);
  }

  private async toBin(file: TFile): Promise<string> {
    const s = this.settings();
    const bin = normalizePath(`${s.rootFolder || "NeoPen"}/_cestino`);
    if (!(await this.app.vault.adapter.exists(bin))) await this.app.vault.createFolder(bin).catch(() => undefined);
    const stamp = moment().format("YYYY-MM-DD HH-mm");
    const target = await this.freePath(bin, sanitizeName(`${file.basename} (${stamp})`));
    await this.app.fileManager.renameFile(file, target);
    return target;
  }

  /** Dimentica le pagine la cui nota non esiste più (es. cancellata a mano). */
  forgetMissing(ids: string[]): void {
    for (const id of ids) {
      const ref = this.settings().pageNotes[id];
      if (ref && !(this.app.vault.getAbstractFileByPath(ref.path) instanceof TFile)) delete this.settings().pageNotes[id];
    }
  }

  private async freePath(folder: string, title: string, allow?: string): Promise<string> {
    const make = (suffix: string) => normalizePath(`${folder ? folder + "/" : ""}${title}${suffix}.md`);
    let p = make("");
    for (let i = 2; p !== allow && (await this.app.vault.adapter.exists(p)); i++) p = make(` ${i}`);
    return p;
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => undefined);
  }
}

/** Nome di file valido: niente caratteri vietati, niente spazi doppi. */
export function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** Segnaposto temporaneo per "<%" mentre la nota viene creata (vedi createNote). */
const TP_HIDDEN = "\u2063neopen-templater\u2063";

/** Nome confrontabile: minuscolo, senza accenti, spazi o simboli. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const PAGE_EMBED = /!\[\[[^\]|\n]*_pagine\/(\d+_\d+_\d+_(\d+))\.svg(?:\|[^\]\n]*)?\]\]/;

/** Riquadri «Pagina N» → l'immagine della pagina da sola, com'era. */
export function unwrapPageCallouts(content: string): string {
  return content.replace(/^>[ \t]*\[!pagina\][^\n]*\n>[ \t]*(!\[\[[^\]\n]*_pagine\/[^\]\n]*\]\])[ \t]*$/gm, "$1");
}

/** Ogni immagine di pagina (su una riga sua) in un riquadro chiuso: si apre con un clic. */
export function wrapPageCallouts(content: string): string {
  return content.replace(new RegExp(`^[ \\t]*(${PAGE_EMBED.source})[ \\t]*$`, "gm"), (_m, embed: string, _id: string, page: string) => `> [!pagina]- Pagina ${page}\n> ${embed}`);
}
