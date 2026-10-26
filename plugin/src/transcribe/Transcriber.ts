// Coda di trascrizione: decide quando trascrivere una pagina, manda solo i tratti nuovi
// e aggiunge il testo alla nota della stessa pagina.

import { App, TFile, normalizePath } from "obsidian";
import { NoteRouter, RoutedNote } from "../notes/NoteRouter";
import { applyIndents } from "./indent";
import { adoptPhoneTasks } from "../notes/phoneTasks";
import { expandBounds, renderStrokesPng } from "../render/png";
import { PageStore } from "../store/PageStore";
import { PageKey, Stroke, pageId } from "../types";
import { HandwritingRef, TranscribedLine, parseLine, transcribeWithClaude } from "./claude";
import { svgToPngBase64 } from "../views/handwriting";
import { alphabetScheme, resolveLang } from "./samples";
import { Canvas, DrawingSpec, PlacedLabel, boxToNcode, canvasFor, drawingLayout, drawingSvg, formatDrawingBlock, isConnector, labelTags, linesAfterBlock, moveAnchor, anchorOf, parseDrawingBlock, placeDrawings, addOrphanLabels, normText, placeLabels } from "./drawings";
import { escapeLabelLine } from "./drawings";
import { DrawingRecord, findExtensions, growInto, reconstructRecord, recordPathOf, sameCanvas } from "./drawingUpdate";
import { addReplyInBlock, replaceLineInBlock, hasBlock, stripLegacyPageSections, BLOCK_END, BLOCK_START, checkTasksInBlock, deleteTextInBlock, linesToMarkdown, readBlock, removeLineInBlock, writeIntoBlock } from "./noteBlock";
import { strokeBounds } from "../render/svg";
import { classifyLines, findReplyArrows, underlineReport } from "./lineHint";

export interface TranscriberSettings {
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  auto: boolean;
  idleSeconds: number;
  vocabulary: string;
  blacklist?: string;
  quality: import("./claude").Quality;
  /** Cartella dati del plugin (lì vanno _alfabeto e _disegni). */
  rootFolder: string;
  /** Pagine #alfabeto usate come campioni della calligrafia (id pagina). */
  handwritingRefs: string[];
  /** Usare i campioni (default sì) e quanti (default 4). */
  handwritingEnabled?: boolean;
  handwritingMax?: number;
  /** Lingua delle frasi di riferimento ("auto" = quella di Obsidian). */
  handwritingLang?: string;
}

/** Al massimo tanti campioni della calligrafia per chiamata (ognuno è un'immagine in più, anche se in cache). */
const MAX_REFS = 4;
/** Tag di una pagina campione della calligrafia (in italiano e in inglese). */
const SAMPLE_TAGS = ["alfabeto", "calligrafia", "alphabet", "handwriting"];
const REF_PIXELS = 700_000;

export class Transcriber {
  private timers = new Map<string, number>();
  private queue: { key: PageKey; mode: "new" | "all" }[] = [];
  private running = false;
  private warnedNoKey = false;
  private maxForce = 1023;

  constructor(
    private app: App,
    private store: PageStore,
    private router: NoteRouter,
    private settings: () => TranscriberSettings,
    private log: (m: string) => void,
    private notify: (m: string) => void,
    /** Registra la spesa stimata di una chiamata (in dollari). */
    private onSpend: (dollars: number) => void = () => undefined,
    /** Cartella dove salvare, per ogni trascrizione, immagine, richiesta e risposta ("" = non salvare). */
    private debugDir: () => string = () => "",
    /** Salva l'elenco delle pagine #alfabeto. */
    private saveRefs: (ids: string[]) => Promise<void> = async () => undefined
  ) {}

  private refCache = new Map<string, string>();

  private refPath(id: string): string {
    return normalizePath(`${this.settings().rootFolder || "NeoPen"}/_alfabeto/${id}.png`);
  }

  /** Pagina #alfabeto: si salva come immagine di riferimento (tutta la pagina, in nero), niente nota. */
  private async saveReference(id: string, strokes: Stroke[]): Promise<void> {
    const png = renderStrokesPng(strokes, () => true, this.maxForce, undefined, () => false, () => false, [], REF_PIXELS);
    if (!png) return;
    const a = this.app.vault.adapter;
    const path = this.refPath(id);
    const dir = path.split("/").slice(0, -1).join("/");
    if (!(await a.exists(dir))) await a.mkdir(dir);
    const bin = atob(png.base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await a.writeBinary(path, buf.buffer);
    this.refCache.set(id, png.base64);
    const s = this.settings();
    if (!s.handwritingRefs.includes(id)) await this.saveRefs([...s.handwritingRefs, id]);
  }

  /** Dove sta l'immagine del campione (per le impostazioni). */
  samplePath(id: string): string {
    return this.refPath(id);
  }

  /** Una pagina già scritta (la sua immagine in _pagine) diventa un campione della calligrafia. */
  async addSampleFromPage(id: string): Promise<boolean> {
    const a = this.app.vault.adapter;
    const svgPath = normalizePath(`${this.settings().rootFolder || "NeoPen"}/_pagine/${id}.svg`);
    if (!(await a.exists(svgPath))) return false;
    const b64 = await svgToPngBase64(await a.read(svgPath), REF_PIXELS);
    if (!b64) return false;
    const path = this.refPath(id);
    const dir = path.split("/").slice(0, -1).join("/");
    if (!(await a.exists(dir))) await a.mkdir(dir);
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await a.writeBinary(path, buf.buffer);
    this.refCache.set(id, b64);
    await this.saveRefs([...this.settings().handwritingRefs.filter((x) => x !== id), id]);
    this.log(`Pagina ${id}: aggiunta ai campioni della calligrafia.`);
    return true;
  }

  /** Toglie un campione (la pagina torna una pagina normale per le prossime trascrizioni). */
  async removeSample(id: string): Promise<void> {
    const path = this.refPath(id);
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
    this.refCache.delete(id);
    await this.saveRefs(this.settings().handwritingRefs.filter((x) => x !== id));
  }

  /** Campioni della calligrafia da mandare con ogni pagina (gli ultimi, quanti ne dicono le impostazioni). */
  private async references(): Promise<HandwritingRef[]> {
    const out: HandwritingRef[] = [];
    const s = this.settings();
    if (s.handwritingEnabled === false) return out;
    const max = Math.max(1, Math.min(6, s.handwritingMax || MAX_REFS));
    for (const id of s.handwritingRefs.slice(-max)) {
      let b64 = this.refCache.get(id);
      if (!b64) {
        try {
          const bin = new Uint8Array(await this.app.vault.adapter.readBinary(this.refPath(id)));
          let s = "";
          for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
          b64 = btoa(s);
          this.refCache.set(id, b64);
        } catch {
          continue; // immagine sparita: la si rifà alla prossima trascrizione di quella pagina
        }
      }
      out.push({ pngBase64: b64 });
    }
    return out;
  }

  /**
   * Disegni riconosciuti da Claude: si ritrovano i tratti, si crea un SVG per ognuno (scritte in testo battuto)
   * e al posto di "[[drawing N]]" nel testo va l'immagine. Restituisce i #tag scritti accanto a ogni immagine.
   */
  private async placeDrawingsInLines(
    key: PageKey,
    result: { lines: TranscribedLine[]; drawings: { box: number[]; labels: { text: string; box: number[] }[] }[] },
    png: { ox: number; oy: number; scale: number },
    candidates: Stroke[]
  ): Promise<Map<string, string[]>> {
    const tags = new Map<string, string[]>();
    const marker = /^\[\[\s*(?:drawing|disegno)\s*(\d+)\s*\]\]$/i;
    // i disegni già nella nota (existing > 0) li ha già sistemati labelExisting
    const specs: DrawingSpec[] = result.drawings.map((d) => ((d as { existing?: number }).existing ? { box: [], labels: [] } : d));
    let placed = specs.length ? placeDrawings(specs, png, candidates) : [];
    // note in fondo a una freccia che Claude ha lasciato nel testo (invece di darle come scritte del disegno): si
    // ritrovano dai tratti e prendono il testo dalle righe che seguono il disegno
    if (placed.length) {
      const after = (index: number): string[] => {
        const at = result.lines.findIndex((l) => new RegExp(`^\\[\\[\\s*(?:drawing|disegno)\\s*${index + 1}\\s*\\]\\]$`, "i").test(l.text.trim()));
        const out: string[] = [];
        for (let i = at + 1; at >= 0 && i < result.lines.length && result.lines[i].kind === "text" && !marker.test(result.lines[i].text.trim()); i++) out.push(...result.lines[i].text.split(/\r?\n/));
        return out;
      };
      const n = addOrphanLabels(specs as never, placed, png, candidates, after);
      if (n) {
        this.log(`Note in fondo a una freccia ritrovate dai tratti: ${n}.`);
        placed = placeDrawings(specs, png, candidates);
      }
    }
    // per ogni disegno: il blocco, le sue scritte come righe accanto (con la loro grandezza) e quante righe
    // del testo di Claude gli stanno di fianco
    const embeds: { block: string; labels: TranscribedLine[]; claudeLines: number }[] = [];
    for (const d of placed) {
      const first = Math.min(...d.strokes.map((st) => st.t));
      const path = normalizePath(`${this.settings().rootFolder || "NeoPen"}/_disegni/${pageId(key)}-${first}.svg`);
      // la tela comprende le scritte: nella nota vanno sopra il disegno, nel punto in cui le hai scritte
      const { svg, labels: pos, canvas } = drawingLayout(d, { maxForce: this.maxForce });
      await this.saveRecord(path, { v: 1, strokes: d.strokes.map((st) => st.t), canvas });
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, svg);
      else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => undefined);
        await this.app.vault.create(path, svg);
      }
      // le scritte: righe vere della nota subito dopo il disegno (dall'alto in basso), mostrate sopra il disegno
      // nell'ordine di Claude: nota per nota, ogni nota dall'alto in basso
      const sorted = pos;
      const claudeLines = d.beside?.lines ?? 0;
      const block = formatDrawingBlock(path, [], claudeLines && d.beside ? { side: d.beside.side, lines: claudeLines } : undefined, sorted);
      embeds.push({ block, labels: sorted.map((l) => ({ kind: "text", text: escapeLabelLine(l.text), checked: false, due: "" })), claudeLines });
      tags.set(block, labelTags(d));
    }
    if (placed.length) this.log(`Disegni nella pagina ${key.page}: ${placed.length} (con ${placed.reduce((n, d) => n + d.labels.length, 0)} scritte).`);
    // "[[drawing N]]" → disegno + scritte; i disegni senza segnaposto vanno in fondo.
    // Dopo l'ultima riga accanto al disegno, un a capo: quello che segue riparte sotto il disegno.
    const usedIdx = new Set<number>();
    const lines: TranscribedLine[] = [];
    let pending = 0; // righe di Claude ancora accanto al disegno
    const put = (i: number) => {
      const e = embeds[i];
      usedIdx.add(i);
      lines.push({ kind: "text", text: e.block, checked: false, due: "" }, ...e.labels);
      pending = e.claudeLines;
      if (!pending && e.labels.length) e.labels[e.labels.length - 1].breakAfter = true;
    };
    // le scritte del disegno sono già nelle righe dopo il blocco: se Claude le ha scritte anche nel testo (lo fa
    // a volte, anche se gli si dice di no) quelle copie si scartano
    const norm = normText;
    // una riga di Claude può corrispondere a una scritta, o a più scritte consecutive (una riga andata a capo sulla carta)
    const keys: string[] = [];
    for (const d of placed) {
      const ns = d.labels.map((l) => norm(l.text)).filter(Boolean);
      for (let i = 0; i < ns.length; i++) for (let j = i, cat = ""; j < Math.min(ns.length, i + 4); j++) keys.push((cat += ns[j]));
    }
    const sameText = (a: string, b: string): boolean => {
      if (a === b) return true;
      // una lettera diversa (letta in due modi) in parole lunghe
      if (a.length < 6 || Math.abs(a.length - b.length) > 1) return false;
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
    };
    let lastKept: TranscribedLine | undefined;
    for (const l of result.lines) {
      const m = marker.exec(l.text.trim());
      if (!m) {
        const k = norm(l.text);
        if (k && l.kind === "text" && keys.some((x) => sameText(x, k))) {
          if (pending > 0) pending--;
          if (pending === 0 && lastKept && embeds.some((e) => e.claudeLines)) lastKept.breakAfter = true;
          continue;
        }
        lines.push(l);
        lastKept = l;
        if (pending > 0 && --pending === 0) l.breakAfter = true;
        continue;
      }
      const i = placed.findIndex((d) => d.index === Number(m[1]) - 1);
      if (i >= 0 && embeds[i] && !usedIdx.has(i)) put(i);
    }
    embeds.forEach((_, i) => {
      if (!usedIdx.has(i)) put(i);
    });
    result.lines = lines;
    return tags;
  }

  private async saveRecord(svgPath: string, rec: DrawingRecord): Promise<void> {
    const p = recordPathOf(svgPath);
    const f = this.app.vault.getAbstractFileByPath(p);
    const text = JSON.stringify(rec);
    if (f instanceof TFile) await this.app.vault.modify(f, text);
    else await this.app.vault.create(p, text).catch(() => this.app.vault.adapter.write(p, text));
  }

  private async writeSvg(path: string, svg: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modify(f, svg);
    else await this.app.vault.adapter.write(path, svg);
  }

  /**
   * I disegni di questa pagina che sono in una nota: il file, la nota, i tratti e la tela.
   * (Per quelli fatti prima del .json, tratti e tela si ricostruiscono dall'SVG.)
   */
  private async pageDrawings(key: PageKey, strokes: Stroke[]): Promise<{ svgPath: string; note: TFile; rec: DrawingRecord; strokes: Stroke[] }[]> {
    const dir = normalizePath(`${this.settings().rootFolder || "NeoPen"}/_disegni`);
    if (!(await this.app.vault.adapter.exists(dir))) return [];
    const prefix = `${dir}/${pageId(key)}-`;
    const files = (await this.app.vault.adapter.list(dir)).files.filter((f) => f.startsWith(prefix) && f.endsWith(".svg"));
    if (!files.length) return [];
    const notes = [...new Set(this.router.segmentsOf(key).map((sg) => sg.file))];
    const contents = await Promise.all(notes.map(async (f) => ({ f, c: await this.app.vault.read(f) })));
    const byT = new Map(strokes.map((st) => [st.t, st]));
    const out: { svgPath: string; note: TFile; rec: DrawingRecord; strokes: Stroke[] }[] = [];
    for (const svgPath of files) {
      const note = contents.find((x) => x.c.includes(`file: ${svgPath}`))?.f;
      if (!note) continue;
      let rec: DrawingRecord | null = null;
      const jp = recordPathOf(svgPath);
      if (await this.app.vault.adapter.exists(jp)) {
        try {
          rec = JSON.parse(await this.app.vault.adapter.read(jp));
        } catch {
          rec = null;
        }
      }
      if (!rec) {
        const firstT = Number(/-(\d+)\.svg$/.exec(svgPath)?.[1]);
        rec = reconstructRecord(await this.app.vault.adapter.read(svgPath), firstT, strokes);
        if (!rec) {
          this.log(`Disegno ${svgPath}: non ritrovo i suoi tratti nella pagina, non lo aggiorno.`);
          continue;
        }
        await this.saveRecord(svgPath, rec);
      }
      const mine = rec.strokes.map((t) => byT.get(t)).filter((st): st is Stroke => !!st);
      if (mine.length) out.push({ svgPath, note, rec, strokes: mine });
    }
    return out;
  }

  /** Ridisegna l'SVG su una tela (forse più grande) e sposta di conseguenza le scritte già nella nota; aggiunge le scritte nuove. */
  private async redrawDrawing(
    d: { svgPath: string; note: TFile; rec: DrawingRecord; strokes: Stroke[] },
    canvas: Canvas,
    newLabels: PlacedLabel[]
  ): Promise<void> {
    const old = d.rec.canvas;
    await this.writeSvg(d.svgPath, drawingSvg(d.strokes, canvas, { maxForce: this.maxForce }));
    d.rec = { v: 1, strokes: d.strokes.map((st) => st.t), canvas };
    await this.saveRecord(d.svgPath, d.rec);
    if (sameCanvas(old, canvas) && !newLabels.length) return;
    await this.app.vault.process(d.note, (c) => {
      const lines = c.split("\n");
      const open = lines.findIndex((l, i) => l.startsWith("```neopen-disegno") && lines.slice(i, i + 6).some((x) => x.trim() === `file: ${d.svgPath}`));
      if (open < 0) return c;
      let close = open + 1;
      while (close < lines.length && lines[close].trim() !== "```") close++;
      const spec = parseDrawingBlock(lines.slice(open + 1, close).join("\n"));
      const found = linesAfterBlock(c, d.svgPath, spec.anchors.length);
      const anchors = spec.anchors.map((a) => moveAnchor(a, old, canvas));
      const add = newLabels.map((l) => anchorOf(l, canvas));
      const block = formatDrawingBlock(d.svgPath, spec.labels, spec.beside, [...anchors, ...add]).split("\n");
      const at = found && found.after.length ? found.after[found.after.length - 1] + 1 : close + 1;
      lines.splice(at, 0, ...add.map((l) => escapeLabelLine(l.text)));
      lines.splice(open, close - open + 1, ...block);
      return lines.join("\n");
    });
  }

  /** Tratti nuovi attaccati a un disegno già nella nota: entrano nel disegno (non vanno a Claude). */
  private async extendDrawings(drawings: { svgPath: string; note: TFile; rec: DrawingRecord; strokes: Stroke[] }[], fresh: Stroke[]): Promise<Set<Stroke>> {
    const handled = new Set<Stroke>();
    for (const d of drawings) {
      const mine = new Set(d.strokes);
      const ext = findExtensions(d.strokes, fresh.filter((st) => !handled.has(st) && !mine.has(st)));
      if (!ext.length) continue;
      for (const st of ext) handled.add(st);
      d.strokes = [...d.strokes, ...ext];
      await this.redrawDrawing(d, canvasFor(d.strokes, [], d.rec.canvas), []);
      this.log(`Disegno ${d.svgPath}: aggiunti ${ext.length} tratti nuovi.`);
    }
    return handled;
  }

  /** Scritte nuove accanto a un disegno già nella nota (Claude: existing = N): diventano sue scritte. */
  private async labelExisting(
    result: { drawings: { box: number[]; labels: { text: string; box: number[] }[]; existing?: number }[] },
    png: { ox: number; oy: number; scale: number },
    candidates: Stroke[],
    drawings: { svgPath: string; note: TFile; rec: DrawingRecord; strokes: Stroke[] }[]
  ): Promise<void> {
    const used = new Set<Stroke>();
    for (const spec of result.drawings) {
      const d = spec.existing ? drawings[spec.existing - 1] : undefined;
      if (!d) continue;
      const labelStrokes = new Set<Stroke>();
      const labels = placeLabels(spec.labels, png, candidates, used, labelStrokes, d.strokes);
      for (const st of labelStrokes) used.add(st);
      // pezzi nuovi del disegno (attaccati, nel rettangolo di Claude) e frecce verso le scritte nuove
      const free = candidates.filter((st) => !used.has(st));
      const box = boxToNcode(spec.box, png);
      const grown = box ? growInto(d.strokes, free, box) : [];
      const db = strokeBounds(d.strokes)!;
      const arrows = labels.length ? free.filter((st) => !grown.includes(st) && isConnector(st, db, labels)) : [];
      const added = [...grown, ...arrows];
      for (const st of added) used.add(st);
      if (!labels.length && !added.length) continue;
      d.strokes = [...d.strokes, ...added];
      await this.redrawDrawing(d, canvasFor(d.strokes, labels, d.rec.canvas), labels);
      if (added.length) this.log(`Disegno ${d.svgPath}: aggiunti ${added.length} tratti nuovi.`);
      if (!labels.length) continue;
      const tags = labelTags({ labels }).filter((t) => !this.router.ruleTags().includes(t));
      if (tags.length)
        await this.app.fileManager.processFrontMatter(d.note, (fm) => {
          const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
          const low = cur.map((c) => c.toLowerCase());
          const add = tags.filter((t) => !low.includes(t));
          if (add.length) fm.tags = [...cur.filter(Boolean), ...add];
        });
      this.log(`Disegno ${d.svgPath}: scritte nuove ${labels.map((l) => `«${l.text}»`).join(", ")}.`);
    }
  }

  /** Copia di quello che è stato mandato a Claude e di cosa ha risposto (per capire gli errori). */
  private async dump(key: PageKey, tag: string, data: Record<string, unknown>, pngBase64: string): Promise<void> {
    const dir = this.debugDir();
    if (!dir) return;
    try {
      const a = this.app.vault.adapter;
      if (!(await a.exists(dir))) await a.mkdir(dir);
      const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-");
      const base = `${dir}/${stamp} ${pageId(key)} ${tag}`;
      await a.write(`${base}.json`, JSON.stringify(data));
      const bin = atob(pngBase64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      await a.writeBinary(`${base}.png`, buf.buffer);
    } catch (e) {
      this.log(`Debug: impossibile salvare la copia della trascrizione (${String(e)}).`);
    }
  }

  /**
   * Giorno di una parte della pagina: una pagina può essere scritta in giorni diversi (la parte sotto il
   * titolo k è di oggi, quella sopra di ieri). Vale il primo tratto sotto la doppia sottolineatura di quella
   * parte; se le doppie misurate non corrispondono ai titoli, resta il momento del primo tratto della pagina.
   */
  private groupCreated(fallback: number, visible: Stroke[], doubles: { y: number; top: boolean }[], k: number, news: number): number {
    const all = [...doubles].sort((a, b) => a.y - b.y);
    const mid = all.filter((d) => !d.top);
    const ds = all.length === news ? all : mid.length === news ? mid : null;
    if (!ds) return fallback;
    const from = ds[k - 1].y + 0.5;
    const to = k < ds.length ? ds[k].y - 2 : Infinity;
    let t = Infinity;
    for (const st of visible) {
      const y = st.pts[1];
      if (y > from && y <= to && st.t < t) t = st.t;
    }
    return Number.isFinite(t) ? t : fallback;
  }

  /**
   * #tag aggiunto dopo in una pagina con più titoli: a quale parte va? Al titolo subito sotto (o accanto),
   * altrimenti a quello della parte in cui sta. Usa le doppie sottolineature misurate; "" se non è chiaro.
   */
  private tagTarget(segIds: string[], visible: Stroke[], toDo: Stroke[]): string {
    const nb = strokeBounds(toDo);
    if (!nb || nb.maxY - nb.minY > 3.5) return "";
    return pickTagSegment(
      segIds,
      underlineReport(visible, visible).doubles.map((d) => d.y),
      (nb.minY + nb.maxY) / 2
    );
  }

  /** Parte della pagina in cui cominciano i tratti nuovi (in base ai titoli con doppia sottolineatura); "" se non si sa. */
  private textTarget(segIds: string[], visible: Stroke[], toDo: Stroke[]): string {
    const nb = strokeBounds(toDo.filter((st) => st.tip !== 1 && st.pts.length >= 3));
    if (!nb) return "";
    return pickTextSegment(segIds, underlineReport(visible, visible).doubles.map((d) => d.y), nb.minY);
  }

  /** Nota già esistente da riusare per il titolo a metà pagina numero k (ritrascrivi da capo). */
  private pickSegment(
    segs: RoutedNote[],
    k: number,
    title: string,
    groups: { title?: string }[],
    used: Set<string>
  ): RoutedNote | null {
    const free = segs.slice(1).filter((sg) => !used.has(sg.blockId));
    const titleOf = (sg: RoutedNote) => looseText(this.router.titleOf(sg.blockId));
    const want = looseText(title);
    const exact = free.find((sg) => want && titleOf(sg) === want);
    if (exact) return exact;
    const near = free.find((sg) => {
      const t = titleOf(sg);
      return want && t && (t.includes(want) || want.includes(t) || similar(t, want));
    });
    if (near) return near;
    // la k-esima, se il suo titolo non è quello di un altro titolo della pagina
    const kth = segs[k];
    if (kth && !used.has(kth.blockId)) {
      const t = titleOf(kth);
      if (!t || !groups.some((g) => g.title && looseText(g.title) === t)) return kth;
    }
    return null;
  }

  setMaxForce(v?: number): void {
    if (v && v > 0) this.maxForce = v;
  }

  /**
   * Chiamata a ogni nuovo tratto. Per spendere poco si fa UNA chiamata per pagina quando hai finito:
   * appena passi a un'altra pagina, quando scolleghi la penna, oppure dopo una pausa lunga.
   */
  onStroke(key: PageKey, source: "live" | "offline"): void {
    if (!this.settings().auto || source === "offline") return; // l'offline si fa alla fine del download
    const id = pageId(key);
    // sei passato a un'altra pagina: quella di prima è finita, trascrivila subito
    for (const [other, t] of [...this.timers]) {
      if (other === id) continue;
      window.clearTimeout(t);
      this.timers.delete(other);
      const [section, owner, note, page] = other.split("_").map(Number);
      this.enqueue({ section, owner, note, page }, "new");
    }
    const prev = this.timers.get(id);
    if (prev) window.clearTimeout(prev);
    const delay = Math.max(5, this.settings().idleSeconds || 60) * 1000;
    this.timers.set(
      id,
      window.setTimeout(() => {
        this.timers.delete(id);
        this.enqueue(key, "new");
      }, delay)
    );
  }

  /** Dopo il download offline: trascrive tutte le pagine che hanno tratti nuovi. */
  onOfflineDone(): void {
    if (!this.settings().auto) return;
    // in ordine di pagina: così una freccia "→ 7" viene letta prima di trascrivere la pagina 7
    const pages = this.store.pendingPages().sort((a, b) => a.note - b.note || a.page - b.page);
    for (const key of pages) this.enqueue(key, "new");
  }

  /** Quando la penna si disconnette: non aspettare il timer. */
  flushTimers(): void {
    for (const [id, t] of this.timers) {
      window.clearTimeout(t);
      const [section, owner, note, page] = id.split("_").map(Number);
      this.enqueue({ section, owner, note, page }, "new");
    }
    this.timers.clear();
  }

  enqueue(key: PageKey, mode: "new" | "all"): void {
    const id = pageId(key);
    const existing = this.queue.find((q) => pageId(q.key) === id);
    if (existing) {
      if (mode === "all") existing.mode = "all";
    } else {
      this.queue.push({ key, mode });
    }
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await this.transcribe(job.key, job.mode);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          this.log(`Trascrizione fallita (${pageId(job.key)}): ${msg}`);
          this.notify(`Neo Pen: trascrizione fallita. ${msg}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async transcribe(key: PageKey, mode: "new" | "all"): Promise<void> {
    const s = this.settings();
    if (!s.apiKey) {
      if (!this.warnedNoKey) {
        this.log("Trascrizione saltata: inserisci la chiave API di Claude nelle impostazioni.");
        this.notify("Neo Pen: per trascrivere inserisci la chiave API di Claude nelle impostazioni.");
        this.warnedNoKey = true;
      }
      return;
    }

    if (mode === "all") await this.store.clearTranscribed(key);
    const page = await this.store.load(key);
    let toDo = page.strokes.filter((st) => !st.tx && st.tip !== 1 && st.pts.length >= 3);
    if (!toDo.length) return;
    let newSet = new Set(toDo.map((st) => st.t));
    // pagina dell'alfabeto già riconosciuta: si aggiorna solo l'immagine di riferimento (niente nota, niente Claude)
    if (s.handwritingRefs.includes(pageId(key))) {
      await this.saveReference(pageId(key), page.strokes.filter((st) => st.tip !== 1 && st.pts.length >= 3));
      await this.store.markTranscribed(key, [...newSet]);
      this.log(`Pagina ${key.page} (#alfabeto): campione della calligrafia aggiornato.`);
      return;
    }
    const hasContext = page.strokes.some((st) => st.tx && st.tip !== 1);

    // disegni già nella nota: i tratti nuovi attaccati a un disegno lo completano (senza passare da Claude)
    const drawings = hasContext && mode === "new" ? await this.pageDrawings(key, page.strokes) : [];
    if (drawings.length) {
      const handled = await this.extendDrawings(drawings, toDo);
      if (handled.size) {
        await this.store.markTranscribed(key, [...handled].map((st) => st.t));
        for (const st of handled) st.tx = st.tx ?? Date.now();
        toDo = toDo.filter((st) => !handled.has(st));
        newSet = new Set(toDo.map((st) => st.t));
        if (!toDo.length) {
          this.log(`Pagina ${key.page}: solo tratti aggiunti ai disegni, niente testo nuovo.`);
          return;
        }
      }
    }

    // Ritaglio attorno ai tratti nuovi (più qualche riga sopra come contesto): il corsivo arriva più grande.
    // Pochi tratti piccoli (una spunta, una sottolineatura): si manda tutta la riga, così si legge a quale task appartengono.
    // Con "ritrascrivi da capo" si manda tutta la pagina.
    const visible = page.strokes.filter((st) => st.tip !== 1 && st.pts.length >= 3);
    const pageBounds = strokeBounds(visible);
    const newBounds = strokeBounds(toDo);
    let focus: ReturnType<typeof expandBounds> | undefined;
    if (hasContext && pageBounds && newBounds) {
      const small = newBounds.maxX - newBounds.minX < 8 && newBounds.maxY - newBounds.minY < 8;
      focus = small
        ? {
            minX: pageBounds.minX,
            maxX: pageBounds.maxX,
            minY: Math.max(pageBounds.minY, newBounds.minY - 7),
            maxY: Math.min(pageBounds.maxY, newBounds.maxY + 5),
          }
        : expandBounds(newBounds, { x: 14, top: 12, bottom: 4 }, pageBounds);
    }
    // sottolineature, doppie sottolineature e cancellature misurate dai tratti (le cancellature vanno in rosso)
    const report = underlineReport(toDo, visible);
    const struck = new Set(report.strikes);
    const red = new Set(report.red);
    // le parole nuove cancellate (e le loro linee) non arrivano proprio a Claude: niente da trascrivere per sbaglio
    const gone = new Set<Stroke>([...report.erased, ...report.hidden]);
    // frecce di risposta (da una riga a una scritta più sotto): in blu e numerate, così Claude collega bene
    const arrows = findReplyArrows(
      toDo.filter((st) => !gone.has(st) && !struck.has(st)),
      visible.filter((st) => !gone.has(st)),
      new Set<Stroke>([...struck, ...gone])
    );
    const arrowSet = new Set(arrows.map((a) => a.stroke));
    const png = renderStrokesPng(
      page.strokes.filter((st) => !gone.has(st)),
      (st) => newSet.has(st.t),
      this.maxForce,
      focus,
      (st) => red.has(st),
      (st) => arrowSet.has(st),
      arrows.flatMap((a, i) => [
        { x: a.start.x, y: a.start.y, label: String(i + 1) },
        { x: a.end.x, y: a.end.y, label: String(i + 1) },
      ])
    );
    if (!png) return;
    if (struck.size)
      this.log(
        `Cancellature riconosciute dai tratti: ${struck.size}` +
          (report.erased.length ? `; tolti dall'immagine ${report.erased.length} tratti di testo cancellato` : "") +
          (red.size ? `; ${red.size} sopra testo già trascritto (in rosso per Claude)` : "") +
          "."
      );

    this.log(
      `Trascrivo quaderno ${key.note} pagina ${key.page}: ${toDo.length} tratti nuovi` +
        (hasContext ? " (il resto come contesto)…" : "…")
    );
    // "oggi" e "domani" sono rispetto a quando hai scritto (conta anche ritrascrivendo giorni dopo)
    const writtenAt = Math.min(...toDo.map((st) => st.t).filter((t) => t > 1_000_000_000_000));
    const today = new Date(Number.isFinite(writtenAt) ? writtenAt : Date.now()).toLocaleDateString("sv-SE"); // YYYY-MM-DD
    // nota già assegnata? (se sì, il testo già trascritto fa da contesto: tutte le parti della pagina, in ordine)
    let routed = this.router.get(key);
    let previousText = "";
    if (hasContext && routed) {
      const parts: string[] = [];
      for (const sg of this.router.segmentsOf(key)) parts.push(readBlock(await this.app.vault.read(sg.file), sg.blockId));
      previousText = parts.filter(Boolean).join("\n").split("\n").slice(-30).join("\n");
    }
    // Pagina di continuazione ancora vuota: diamo a Claude la fine della pagina precedente,
    // così una frase spezzata tra due pagine resta una riga sola.
    let prevPageId = "";
    let previousPageText = "";
    if (!hasContext) {
      const order = this.router.chain(pageId(key));
      const idx = order.indexOf(pageId(key));
      if (idx > 0) {
        prevPageId = order[idx - 1];
        const prevNote = this.router.noteOfBlock(prevPageId);
        if (prevNote) previousPageText = readBlock(await this.app.vault.read(prevNote.file), prevPageId).split("\n").slice(-6).join("\n");
      }
    }
    const includesTop = !focus || !pageBounds || focus.minY <= pageBounds.minY + 0.5;
    // pagina che continua un'altra nota (freccia sulla pagina prima): niente titolo della pagina, tutti i titoli
    // con la doppia linea si scrivono "== titolo" in ordine; quello in cima lo sistema poi il plugin (resta nella nota)
    const cont = this.router.isContinuation(key) && includesTop;
    const arrowNote = arrows.length
      ? ` Measured from the pen strokes: ${arrows.length === 1 ? "1 reply arrow is" : `${arrows.length} reply arrows are`} drawn in BLUE and numbered with a blue circle at both ends: arrow N starts next to the line it answers (circle N at the start → "to") and ends at the reply writing (circle N at the end → "text"). Write exactly one replies entry for each blue arrow, in order 1..${arrows.length}; gray arrows were already handled.`
      : "";
    // disegni già nella nota (in grigio nell'immagine): le scritte nuove accanto diventano loro scritte
    const existingNote = drawings.length
      ? ` EXISTING DRAWINGS (gray, already in the note): ${drawings
          .map((d, i) => {
            const b = strokeBounds(d.strokes)!;
            const px = (v: number, o: number) => Math.round((v - o) * png.scale);
            return `${i + 1} = box [${px(b.minX, png.ox)}, ${px(b.minY, png.oy)}, ${px(b.maxX, png.ox)}, ${px(b.maxY, png.oy)}]`;
          })
          .join("; ")}. NEW black writing that belongs to one of these (a name, a #tag beside it, or a note joined to it by an arrow or a line, even several lines or a list), and NEW black strokes that add a part or an arrow to one of these drawings: add a drawings entry with existing = its number, box = the rectangle around that drawing including its new strokes, labels = only the new writing, one label per note (its lines joined with "\\n" as on paper; never mix two notes written side by side); do not write them in lines and add no "[[drawing N]]" for it.`
      : "";
    const hint =
      report.hint +
      arrowNote +
      existingNote +
      (cont
        ? ` This page continues the previous note: page_title must be empty; write EVERY twice-underlined title as "== title" in lines, in order from top to bottom${report.doubles.some((d) => d.top) ? ` (the first one is the short line at the very top of the page, above everything else)` : ""}.`
        : "");
    const titles = routed ? this.router.segmentTitles(key) : [];
    const knownTags = [...new Set([...this.router.knownTags(), ...SAMPLE_TAGS])];
    const references = await this.references();
    let result = await transcribeWithClaude({
      apiKey: s.apiKey,
      apiBaseUrl: s.apiBaseUrl,
      model: s.model,
      pngBase64: png.base64,
      hasContext,
      today,
      previousText,
      vocabulary: s.vocabulary,
      quality: s.quality,
      // la parte alta della pagina è nell'immagine? (serve per riconoscere tag e titolo)
      includesTop,
      previousPageText,
      // sottolineatura o cancellatura? lo dice la posizione delle linee rispetto alle lettere
      lineHint: hint,
      titles,
      knownTags,
      blacklist: s.blacklist ?? "",
      imageSize: { width: png.width, height: png.height },
      references,
      scheme: alphabetScheme(resolveLang(s.handwritingLang)),
    });
    const dumpData = (r: typeof result) => ({
      mode,
      hint,
      userText: r.userText,
      raw: r.raw,
      strikes: report.strikes.map((st) => st.t),
      erased: report.erased.map((st) => st.t),
      red: report.red.map((st) => st.t),
      doubles: report.doubles,
      focus,
      strokes: page.strokes.map((st) => ({ t: st.t, tip: st.tip, tx: st.tx ? 1 : 0, pts: st.pts.map((v) => Math.round(v * 100) / 100) })),
    });
    await this.dump(key, "risposta", dumpData(result), png.base64);
    // Controlli con la geometria dei tratti; se la risposta non torna si riprova una volta, spiegando perché.
    let retry = "";
    // 1) parole sottolineate ma niente trascritto (le ha prese per cancellate)
    const nothing = !result.lines.some((l) => l.text.trim()) && !result.page_title && !result.corrections.length && !result.new_titles.length;
    // 0) niente di niente (né righe, né scritte di disegni, né spunte o cancellature) con tanta scrittura nuova:
    //    la scrittura non deve andare persa, si riprova
    const writing = toDo.filter((st) => !struck.has(st) && !gone.has(st)).length;
    const silent =
      nothing &&
      !result.drawings.some((d) => d.labels.length) &&
      !result.checked_tasks.length &&
      !result.deleted_text.length &&
      !result.replies.length;
    if (silent && writing >= 8) {
      retry = `IMPORTANT: your previous answer transcribed nothing, but there is new BLACK writing on this page (${writing} pen strokes). Transcribe it: in lines, or as labels of a drawing (new or existing) when it is joined to the drawing by an arrow or a line.`;
      this.log(`Nessun testo nella risposta ma ${writing} tratti nuovi: riprovo la trascrizione…`);
    } else if (hint.includes("UNDERLINE") && nothing && classifyLines(toDo, visible).length < toDo.length) {
      retry =
        "IMPORTANT: your previous answer transcribed nothing, but there are written words just above that underline. An underline never deletes words: transcribe those words (in **bold** for a single underline; as a title for a double underline).";
      this.log("Sottolineatura presa per cancellatura? Riprovo la trascrizione con un'indicazione più chiara…");
    }
    // 2) titolo "in cima" ma la doppia sottolineatura sta a metà pagina (sopra c'è altro testo)
    else if (result.page_title && report.doubles.length && !report.doubles.some((d) => d.top)) {
      retry = `IMPORTANT: your previous answer used "${result.page_title}" as page_title, but its double underline is in the MIDDLE of the page (there is other text above it). page_title must be empty: write that title as "== ${result.page_title}" in lines, at its position, with the #tag written just above it if any ("== ${result.page_title} #tag"). Text above it stays before it.`;
      this.log(`«${result.page_title}» non è in cima alla pagina: è un titolo a metà pagina (nota nuova). Riprovo la trascrizione…`);
    }
    // 3) mancano titoli: le doppie sottolineature misurate sono più dei titoli nella risposta
    else {
      const out = result.lines.filter((l) => l.kind === "newnote").length + (result.page_title ? 1 : 0) + result.new_titles.length;
      const want = report.doubles.length;
      if (want > out) {
        const got = [result.page_title, ...result.lines.filter((l) => l.kind === "newnote").map((l) => l.text)].filter(Boolean);
        retry = `IMPORTANT: the pen strokes show ${want} twice-underlined titles on this page, but your answer has only ${out}${got.length ? ` (${got.map((t) => `"${t}"`).join(", ")})` : ""}. Look again for the missing one${want - out > 1 ? "s" : ""} (${report.doubles.some((d) => d.top) ? "one is at the very top of the page, even if it is short" : "each has two lines under it"}) and write ${cont ? 'each title as "== title"' : 'the top one as page_title and the others as "== title"'} in lines, in order.`;
        this.log(`Titoli con doppia sottolineatura: ${want} sulla pagina, ${out} nella risposta. Riprovo la trascrizione…`);
      }
    }
    if (retry) {
      const first = result;
      result = await transcribeWithClaude({
        apiKey: s.apiKey,
        apiBaseUrl: s.apiBaseUrl,
        model: s.model,
        pngBase64: png.base64,
        hasContext,
        today,
        previousText,
        vocabulary: s.vocabulary,
        quality: s.quality,
        includesTop,
        previousPageText,
        lineHint: `${hint} ${retry}`,
        titles,
        knownTags,
        blacklist: s.blacklist ?? "",
        imageSize: { width: png.width, height: png.height },
        references,
      scheme: alphabetScheme(resolveLang(s.handwritingLang)),
      });
      result.usage.cost += first.usage.cost;
      await this.dump(key, "riprova", dumpData(result), png.base64);
      // se insiste, il titolo a metà pagina non diventa comunque il titolo della pagina
      if (result.page_title && report.doubles.length && !report.doubles.some((d) => d.top)) {
        result.lines.unshift({ kind: "newnote", text: result.page_title, checked: false, due: "", time: "", tag: result.page_tag || undefined });
        result.page_tag = "";
        result.page_title = "";
      }
    }

    this.onSpend(result.usage.cost);
    const cents = (result.usage.cost * 100).toFixed(2).replace(".", ",");
    const cached = result.usage.cacheReadTokens ? `, ${result.usage.cacheReadTokens} in cache` : "";
    this.log(`Costo ≈ ${cents} cent (${result.usage.inputTokens + result.usage.cacheReadTokens} token in entrata${cached}, ${result.usage.outputTokens} in uscita).`);

    // pagina #alfabeto: diventa un campione della calligrafia per le prossime trascrizioni, non una nota
    if (SAMPLE_TAGS.includes(result.page_tag)) {
      await this.saveReference(pageId(key), visible);
      await this.store.markTranscribed(key, [...newSet]);
      this.log(`Pagina ${key.page}: #alfabeto, la uso come campione della tua calligrafia (${this.settings().handwritingRefs.length} pagine).`);
      this.notify(`Neo Pen: pagina ${key.page} salvata come campione della tua calligrafia.`);
      return;
    }


    const force = mode === "all";
    const pid = pageId(key);

    // parole "vietate" (letture sbagliate tipiche della tua grafia): sostituite con la parola frequente più simile
    if ((s.blacklist ?? "").trim()) {
      const fix = (t: string) => fixBlacklisted(t, s.blacklist ?? "", s.vocabulary);
      for (const l of result.lines) l.text = fix(l.text);
      for (const r of result.replies) r.text = fix(r.text);
      result.page_title = fix(result.page_title);
      result.corrections = result.corrections.map((c) => ({ ...c, new_line: fix(c.new_line) }));
    }

    // "oggi" / "domani" / "dopodomani" in un task senza data: la data si calcola qui (se il modello l'ha dimenticata)
    for (const l of result.lines) {
      if (l.kind !== "task" || l.due) continue;
      const m = /\b(dopodomani|domani|oggi)\b/i.exec(l.text);
      if (!m) continue;
      const add = { oggi: 0, domani: 1, dopodomani: 2 }[m[1].toLowerCase() as "oggi" | "domani" | "dopodomani"];
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() + add);
      l.due = d.toLocaleDateString("sv-SE");
    }

    // Pagina che continua un'altra nota: un titolo dato come page_title è il primo "== titolo"
    // (se la doppia linea in cima non c'è davvero, è solo testo in grassetto).
    if (result.page_title && this.router.isContinuation(key)) {
      if (report.doubles.some((d) => d.top)) {
        result.lines.unshift({ kind: "newnote", text: result.page_title, checked: false, due: "", time: "", tag: result.page_tag || undefined });
      } else {
        this.log(`«${result.page_title}»: non trovo una doppia sottolineatura in cima alla pagina, la pagina resta dov'è (testo in grassetto).`);
        result.lines.unshift({ kind: "text", text: `**${result.page_title}**`, checked: false, due: "" });
      }
      result.page_tag = "";
      result.page_title = "";
    }

    // disegni: al posto di "[[drawing N]]" l'immagine del disegno con le scritte in testo battuto
    // (si usano tutti i tratti nuovi: il tratteggio di un disegno a volte sembra una cancellatura e non è nell'immagine per Claude)
    {
      const n = applyIndents(result.lines, png, toDo);
      if (n) this.log(`Righe rientrate come sulla carta: ${n}.`);
    }
    if (drawings.length) await this.labelExisting(result, png, toDo, drawings);
    const drawingTags = await this.placeDrawingsInLines(key, result, png, toDo);

    // titoli già letti male una volta e corretti da te (rinominando la nota)
    // "#task" sottolineato due volte in cima: è il tag della pagina, non il suo titolo
    {
      const m = /^#([\p{L}\p{N}_\-/]+)$/u.exec(result.page_title.trim());
      if (m) {
        if (!result.page_tag) result.page_tag = m[1].toLowerCase();
        this.log(`«${result.page_title}» in cima è il tag della pagina, non un titolo.`);
        result.page_title = "";
      }
    }
    if (result.page_title) result.page_title = this.router.fixTitle(result.page_title);
    for (const l of result.lines) if (l.kind === "newnote") l.text = this.router.fixTitle(l.text);

    // Titoli con doppia sottolineatura a metà pagina: da lì comincia una nota nuova.
    const groups: { title?: string; tag?: string; lines: TranscribedLine[] }[] = [{ lines: [] }];
    for (const l of result.lines) {
      if (l.kind === "newnote") groups.push({ title: l.text, tag: l.tag || undefined, lines: [] });
      else groups[groups.length - 1].lines.push(l);
    }

    // Una pagina che continua un'altra nota (con la freccia "→ N" sulla pagina prima) resta in quella nota:
    // la freccia vale più di un titolo in cima alla pagina, che resta nel testo in grassetto.
    // (I titoli a metà pagina aprono comunque una nota nuova.) Il titolo in cima c'è se i titoli nella risposta
    // sono uno in più delle doppie sottolineature a metà pagina e prima del primo non c'è testo.
    if (this.router.isContinuation(key) && groups.length > 1 && !groups[0].lines.some((l) => l.text.trim())) {
      const mids = report.doubles.filter((d) => !d.top).length;
      if (report.doubles.some((d) => d.top) && groups.length - 1 === mids + 1) {
        const top = groups.splice(1, 1)[0];
        this.log(`«${top.title}»: la pagina continua la nota precedente (freccia), il titolo in cima resta nel testo in grassetto.`);
        groups[0].lines = [{ kind: "text", text: `**${top.title}**`, checked: false, due: "" }, ...top.lines];
      }
    }

    // #tag dei template: sono SEMPRE il template di un titolo, mai testo (né tag della nota sopra).
    const isTemplate = (t: string) => !!this.router.ruleFor(t);
    if (result.page_tag && !result.page_title && groups.length > 1 && !groups[1].tag && isTemplate(result.page_tag) && !groups[0].lines.length) {
      // tag "in cima" ma subito sopra il primo titolo a metà pagina: è suo
      groups[1].tag = result.page_tag;
      result.page_tag = "";
    }
    const laterTags: { bid: string; tag: string }[] = [];
    const segIds = routed ? this.router.segmentIds(key) : [pid];
    /** Il tag va alla parte (già esistente) indicata, o alla nota della pagina. */
    const tagFor = (bid: string, tag: string) => {
      if (!bid || bid === pid) {
        if (!result.page_tag) result.page_tag = tag;
      } else if (!laterTags.some((l) => l.bid === bid)) laterTags.push({ bid, tag });
    };
    /** Tag già assegnati da Claude a un titolo preciso: la stessa scritta trovata nel testo non va altrove. */
    const claimed = new Set<string>();
    for (const tt of result.title_tags) {
      if (!isTemplate(tt.tag)) continue;
      claimed.add(tt.tag);
      const want = looseText(tt.title);
      const g = groups.slice(1).find((x) => x.title && (looseText(x.title) === want || looseText(x.title).includes(want) || want.includes(looseText(x.title))));
      if (g) {
        if (!g.tag) g.tag = tt.tag;
      } else if (result.page_title && looseText(result.page_title) === want) {
        if (!result.page_tag) result.page_tag = tt.tag;
      } else {
        const bid = this.router.segmentWithTitle(key, tt.title);
        if (bid) tagFor(bid, tt.tag);
      }
    }
    const leftovers = assignTemplateTags(groups, isTemplate);
    for (const tag of leftovers.filter((t) => !claimed.has(t))) {
      // in alto (o pagina nuova): è il tag della pagina; aggiunto dopo, sotto altri titoli: quello più vicino
      let bid = "";
      if (!force && segIds.length > 1) bid = this.tagTarget(segIds, visible, toDo) || segIds[segIds.length - 1];
      tagFor(bid, tag);
    }

    // I tag "di pagina" (quello in cima, quelli dei template e quelli con una regola) non devono comparire nel testo.
    const hiddenTags = new Set<string>([
      ...(result.page_tag ? [result.page_tag] : []),
      ...this.router.ruleTags(),
      ...groups.flatMap((g) => (g.tag ? [g.tag] : [])),
      ...laterTags.map((l) => l.tag),
      ...result.tags.map((t) => t.replace(/^#/, "").toLowerCase()).filter(isTemplate),
    ]);
    for (const g of groups) g.lines = stripTags(g.lines, hiddenTags);
    result.tags = result.tags.filter((t) => !isTemplate(t.replace(/^#/, "").toLowerCase()) || t.replace(/^#/, "").toLowerCase() === result.page_tag);
    // le risposte (scritte collegate con una freccia a una riga) non sono righe a sé, né task
    if (result.replies.length) {
      const rs = result.replies.map((r) => looseText(r.text)).filter(Boolean);
      // anche se copiata un po' diversa (una parola letta male, un pezzo in più o in meno)
      const isReply = (t: string) => {
        const n = looseText(t);
        if (!n) return false;
        const words = n.split(" ").filter((w) => w.length >= 3);
        return rs.some((r) => {
          if (n === r || (n.length > 8 && (r.includes(n) || n.includes(r)))) return true;
          const rw = new Set(r.split(" "));
          return words.length >= 3 && words.filter((w) => rw.has(w)).length >= 0.7 * words.length;
        });
      };
      for (const g of groups) g.lines = g.lines.filter((l) => !isReply(l.text));
    }
    result.lines = groups[0].lines;

    const firstLine = [...result.lines, ...groups.slice(1).flatMap((g) => g.lines)]
      .find((l) => l.text.trim())
      ?.text.replace(/#\S+/g, "")
      .replace(/\*\*/g, "")
      .trim();
    const info = { pageTag: result.page_tag, title: result.page_title || undefined, firstLine, created: page.created };
    /** Titolo riconosciuto ma la nota non si può rinominare: va in testa al testo come intestazione. */
    let titleAsHeading = "";
    if (!routed) {
      routed = await this.router.ensure(key, info);
      if (result.page_title) this.log(`Titolo riconosciuto: "${result.page_title}".`);
    } else {
      // Tag o titolo arrivati DOPO la creazione della nota (es. doppia sottolineatura tracciata dopo,
      // o #tag aggiunto in cima): se la nota è ancora quella di base, la promuoviamo.
      if (result.page_tag && this.router.canReroute(key, result.page_tag, force)) {
        const carried = readBlock(await this.app.vault.read(routed.file), routed.blockId);
        // se nel frattempo una riga è diventata titolo, non la portiamo nel testo
        const carriedClean = result.page_title
          ? readBlock(removeLineInBlock(`${BLOCK_START}\n${carried}\n${BLOCK_END}`, result.page_title))
          : carried;
        routed = await this.router.reroute(key, info, force ? "" : carriedClean);
      } else {
        if (result.page_title) {
          if (this.router.canRetitle(key, result.page_title, force)) {
            await this.router.retitle(key, result.page_title);
            routed = this.router.get(key) ?? routed;
          } else if (this.router.isContinuation(key) && !this.router.hasTitle(key, result.page_title)) {
            // la pagina continuava un'altra nota, ma ora inizia con un titolo: diventa una nota sua
            routed = await this.router.detach(key, info);
          } else if (!this.router.hasTitle(key, result.page_title)) {
            titleAsHeading = result.page_title;
            this.log(`Titolo "${result.page_title}": la nota non è più quella di base, lo metto come intestazione del testo.`);
          }
        }
        if (result.page_tag && !this.router.ruleFor(result.page_tag)) {
          this.log(`Tag #${result.page_tag}: nessuna regola per questo tag, lo aggiungo solo ai tag della nota (crea una regola per usare un template).`);
        } else if (result.page_tag && !this.router.canReroute(key, result.page_tag, force)) {
          this.log(`Tag #${result.page_tag}: la nota non è più quella di base (template o più pagine), il tag non la sposta.`);
        }
      }
    }

    // Parti della pagina: la prima (in cima) e l'ultima (in fondo: lì va il testo nuovo).
    let segs = this.router.segmentsOf(key);
    if (!segs.length) segs = [routed];
    // ritrascrivi da capo: prima una copia di sicurezza delle note che verranno riscritte
    if (force) {
      for (const f of new Set(segs.map((sg) => sg.file))) {
        if (!readBlock(await this.app.vault.read(f), segs.find((sg) => sg.file === f)!.blockId)) continue;
        const copy = await this.router.backup(f, "prima di ritrascrivere");
        this.log(`Copia di sicurezza di "${f.basename}" in "${copy}".`);
      }
    }
    const first = segs[0];
    // testo nuovo: nella parte della pagina in cui è scritto sulla carta (sopra un titolo a metà pagina = la parte
    // prima), non per forza nell'ultima
    let target = force ? first : segs[segs.length - 1];
    if (!force && segs.length > 1) {
      const at = this.textTarget(segs.map((sg) => sg.blockId), visible, toDo);
      const hit = segs.find((sg) => sg.blockId === at);
      if (hit && hit !== target) {
        this.log(`Pagina ${key.page}: il testo nuovo sta sopra il titolo «${this.router.titleOf(target.blockId) || "seguente"}», va nella parte «${this.router.titleOf(hit.blockId) || hit.file.basename}».`);
        target = hit;
      }
    }

    // la prima riga continua la frase della pagina precedente: va attaccata in fondo al suo blocco
    let joinToPrev = "";
    if (previousPageText && result.continues_last_line && result.lines.length && target.blockId !== prevPageId) {
      const firstNew = result.lines.shift()!;
      joinToPrev = linesToMarkdown([firstNew]);
      result.continues_last_line = false;
    }
    // Se i tratti nuovi sono solo linee SOTTO le parole (sottolineature), non si cancella niente.
    const lines = classifyLines(toDo, visible);
    if (result.deleted_text.length && !struck.size && lines.length === toDo.length && lines.every((l) => l.kind === "under")) {
      this.log(`Non cancello "${result.deleted_text.join('", "')}": le linee nuove stanno sotto le parole, sono sottolineature.`);
      result.deleted_text = [];
    }
    // Una spunta lunga che passa sopra le parole non è una cancellatura: mai togliere un task appena spuntato.
    const loose = looseText;
    const ticked = result.checked_tasks.map(loose).filter(Boolean);
    const spared = result.deleted_text.filter((d) => {
      const n = loose(d);
      return n && ticked.some((t) => t.includes(n) || n.includes(t));
    });
    if (spared.length) {
      this.log(`Non cancello "${spared.join('", "')}": è un task appena spuntato (la spunta passava sopra le parole).`);
      result.deleted_text = result.deleted_text.filter((d) => !spared.includes(d));
    }

    // 1) testo nuovo nella sua parte della pagina. Una riga identica a una già presente in quel blocco è una rilettura
    //    del testo grigio (Claude l'ha riscritta): non si duplica.
    if (!force && result.lines.length) {
      const have = new Set(
        readBlock(await this.app.vault.read(target.file), target.blockId)
          .split("\n")
          .map((l) =>
            looseText(
              l
                .replace(/^\s*- \[[ xX]\]\s*/, "")
                .replace(/^\s*-\s+(↳\s*)?/, "")
                .replace(/^\d{1,2}:\d{2}(-\d{1,2}:\d{2})?\s+/, "")
                .replace(/\s*📅.*$/, "")
            )
          )
          .filter((t) => t.length >= 4)
      );
      const before = result.lines.length;
      result.lines = result.lines.filter((l) => l.kind === "newnote" || !have.has(looseText(l.text)));
      if (result.lines.length < before) this.log(`Pagina ${key.page}: ${before - result.lines.length} righe già presenti nella nota, non le ripeto.`);
    }
    // task che il telefono aveva già messo nella nota del giorno: la trascrizione prende il loro posto
    if (!force) await adoptPhoneTasks(this.app, result.lines, (m) => this.log(`Pagina ${key.page}: ${m}`));
    const md = linesToMarkdown(result.lines);
    /** Cosa è stato scritto in quale nota (per mettere i #tag nella nota giusta). */
    const written: { file: TFile; md: string; daily: boolean }[] = [{ file: target.file, md, daily: target.kind === "daily" }];
    if (md || joinToPrev || force) {
      await this.app.vault.process(target.file, (content) => {
        let next = stripLegacyPageSections(content);
        if (joinToPrev) {
          // solo se il blocco della pagina precedente è in questa nota; altrimenti resta qui
          next = hasBlock(next, prevPageId)
            ? writeIntoBlock(next, joinToPrev, "append", true, prevPageId)
            : writeIntoBlock(next, joinToPrev, "append", false, target.blockId);
        }
        if (md || force) next = writeIntoBlock(next, md, force ? "replace" : "append", result.continues_last_line, target.blockId);
        return next;
      });
    }

    // 2) cancellature, correzioni e spunte: in tutte le parti della pagina
    let checked = 0;
    let deleted = 0;
    const fixed: string[] = [];
    const notesTouched = new Set<string>();
    if (!force) {
      const pendingFix = [...result.corrections];
      let toCheck = [...result.checked_tasks];
      for (const fuzzy of [false, true]) {
        for (const sg of segs) {
          if (!toCheck.length && (fuzzy || (!result.deleted_text.length && !pendingFix.length))) break;
          await this.app.vault.process(sg.file, (content) => {
            let next = content;
            if (!fuzzy) {
              if (result.deleted_text.length) {
                const d = deleteTextInBlock(next, result.deleted_text, sg.blockId);
                deleted += d.count;
                next = d.content;
              }
              // parole cancellate e riscritte accanto o sopra: la riga già trascritta viene corretta
              for (const c of [...pendingFix]) {
                const newMd = linesToMarkdown([parseLine(c.new_line)]);
                if (!newMd) continue;
                const r = replaceLineInBlock(next, c.old_line, newMd, sg.blockId);
                if (!r.found) continue;
                next = r.content;
                fixed.push(newMd.replace(/^- \[[ xX]\] /, ""));
                pendingFix.splice(pendingFix.indexOf(c), 1);
              }
            }
            // spunte: prima la corrispondenza esatta in tutte le parti, poi quella "somigliante"
            const r = checkTasksInBlock(next, toCheck, sg.blockId, fuzzy);
            if (r.count) {
              checked += r.count;
              toCheck = toCheck.filter((t) => !r.matched.includes(t));
              notesTouched.add(sg.file.path);
            }
            return r.content;
          });
        }
      }
      // correzioni di righe che non trovo: il testo corretto non va perso
      for (const c of pendingFix) {
        const newMd = linesToMarkdown([parseLine(c.new_line)]);
        if (!newMd) continue;
        await this.app.vault.process(target.file, (content) => writeIntoBlock(content, newMd, "append", false, target.blockId));
        fixed.push(newMd.replace(/^- \[[ xX]\] /, ""));
      }
      for (const t of toCheck) this.log(`Spunta su «${t}»: non trovo un task da spuntare con quel testo nella nota.`);
    }

    // 3) titolo della pagina (in cima): esce dal testo, o diventa intestazione se la nota non si può rinominare
    // nella nota del giorno il titolo non la rinomina (resta la data): resta come etichetta in grassetto
    const dailyLabel = first.kind === "daily" && result.page_title && !titleAsHeading ? result.page_title : "";
    if (result.page_title || titleAsHeading) {
      await this.app.vault.process(first.file, (content) => {
        let next = content;
        if (result.page_title) next = removeLineInBlock(next, result.page_title, first.blockId);
        if (titleAsHeading) {
          const inner = readBlock(next, first.blockId);
          next = writeIntoBlock(next, `### ${titleAsHeading}${inner ? "\n" + inner : ""}`, "replace", false, first.blockId);
        }
        if (dailyLabel) {
          const inner = readBlock(next, first.blockId);
          if (!inner.includes(`**${dailyLabel}**`)) next = writeIntoBlock(next, `**${dailyLabel}**${inner ? "\n" + inner : ""}`, "replace", false, first.blockId);
        }
        return next;
      });
    }

    // 4) titoli con doppia sottolineatura a metà pagina → note nuove
    let after = segs[segs.length - 1].blockId;
    const extraNotes: string[] = [];
    const usedSegs = new Set<string>();
    for (let k = 1; k < groups.length; k++) {
      const g = groups[k];
      let gmd = linesToMarkdown(g.lines);
      let seg: RoutedNote;
      // ritrascrivi da capo: si riusa la nota già creata per lo stesso titolo (non "la k-esima": se un titolo
      // manca o è letto diverso, le altre note non si scambiano il testo)
      const reuse = force ? this.pickSegment(segs, k, g.title ?? "", groups, usedSegs) : null;
      const gCreated = this.groupCreated(page.created, visible, report.doubles, k, groups.length - 1);
      if (reuse) {
        // nella nota del giorno sbagliata (pagina scritta in più giorni): passa in quella del giorno giusto
        seg = await this.router.redate(reuse, gCreated);
      } else {
        seg = await this.router.newSegment(key, { title: g.title, pageTag: g.tag, firstLine: g.title, created: gCreated }, after);
      }
      after = seg.blockId;
      usedSegs.add(seg.blockId);
      // parte mandata nella nota del giorno (#task accanto al titolo): la nota resta col nome della data,
      // il titolo scritto a mano resta come etichetta in grassetto sopra i suoi task
      if (seg.kind === "daily" && g.title) gmd = `**${g.title}**${gmd ? "\n" + gmd : ""}`;
      await this.app.vault.process(seg.file, (c) => writeIntoBlock(c, gmd, force ? "replace" : "append", false, seg.blockId));
      // nota già creata senza template (es. il #tag l'hai scritto dopo): si ricrea col template
      if (g.tag && this.router.ruleFor(g.tag)) {
        const re = await this.router.retemplate(seg.blockId, g.tag, page.created);
        if (re) seg = re;
      }
      written.push({ file: seg.file, md: gmd, daily: seg.kind === "daily" });
      // (la nota del giorno non prende il tag: resta com'è nel tuo template)
      if (g.tag && seg.kind !== "daily") {
        await this.app.fileManager.processFrontMatter(seg.file, (fm) => {
          const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
          fm.tags = [...new Set([...cur.filter(Boolean), g.tag!])];
        });
      }
      extraNotes.push(seg.file.basename);
    }
    if (force) {
      // parti che non ci sono più nella nuova trascrizione: svuotate
      for (const sg of segs.slice(1).filter((x) => !usedSegs.has(x.blockId))) {
        await this.app.vault.process(sg.file, (c) => writeIntoBlock(c, "", "replace", false, sg.blockId));
      }
    }

    // 4b) risposte con la freccia: sotto la riga da cui parte la freccia (sotto-punto "↳", non un task)
    if (result.replies.length) {
      const pending = [...result.replies];
      const parts = this.router.segmentsOf(key);
      for (const fuzzy of [false, true]) {
        for (const sg of parts) {
          if (!pending.length) break;
          await this.app.vault.process(sg.file, (c) => {
            let next = c;
            for (const r of [...pending]) {
              const x = addReplyInBlock(next, r.to, r.text, sg.blockId, fuzzy);
              if (x.found) {
                next = x.content;
                pending.splice(pending.indexOf(r), 1);
              }
            }
            return next;
          });
        }
      }
      // riga di partenza non trovata: la risposta non va persa, resta in fondo al testo
      for (const r of pending) {
        await this.app.vault.process(target.file, (c) => writeIntoBlock(c, `↳ ${r.text}`, "append", false, target.blockId));
        this.log(`Risposta «${r.text}»: non trovo la riga «${r.to}», la metto in fondo al testo.`);
      }
      this.log(`Risposte collegate con la freccia: ${result.replies.length}.`);
    }

    // 5) frecce verso altre pagine: ognuna continua la parte della pagina in cui l'hai disegnata
    //    (registrate prima che si trascriva la pagina di destinazione, che è in coda dopo questa)
    for (const a of result.arrows) {
      const title = a.title && result.page_title && loose(a.title) === loose(result.page_title) ? "" : a.title;
      await this.router.setContinuation(key, a.page, this.router.blockForTitle(key, title));
    }

    // 5b) #tag di un template aggiunto dopo accanto o sopra un titolo già trascritto
    for (const l of laterTags) {
      const re = await this.router.retemplate(l.bid, l.tag, page.created);
      if (re) {
        extraNotes.push(re.file.basename);
        await this.app.fileManager.processFrontMatter(re.file, (fm) => {
          const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
          fm.tags = [...new Set([...cur.filter(Boolean), l.tag])];
        });
      } else this.log(`Tag #${l.tag}: la nota di quel titolo ha già un template (o non è più quella creata in automatico), resta com'è.`);
    }

    // 6) righe già trascritte che ora hanno una doppia sottolineatura → da lì una nota nuova
    for (const t of result.new_titles) {
      const seg = await this.router.splitAt(key, t, page.created);
      if (seg) extraNotes.push(seg.file.basename);
    }

    // 7) il disegno della pagina deve esserci (es. template senza {{disegno}})
    await this.router.ensureDrawing(first, key);

    const note = first.file;
    // #tag scritti nella pagina → proprietà "tags" della nota della parte di pagina in cui stanno
    // (anche quelli scritti accanto a un disegno); il tag della pagina va nella prima nota
    const structural = new Set(this.router.ruleTags());
    const perFile = new Map<string, { file: TFile; tags: Set<string> }>();
    const addTags = (file: TFile, tags: string[]) => {
      const e = perFile.get(file.path) ?? { file, tags: new Set<string>() };
      for (const t of tags) if (t) e.tags.add(t);
      perFile.set(file.path, e);
    };
    if (result.page_tag) addTags(note, [result.page_tag]);
    const placedTags = new Set<string>();
    for (const w of written) {
      const found = inlineTags(w.md).filter((t) => !structural.has(t));
      for (const [embed, t] of drawingTags) if (w.md.includes(embed)) found.push(...t.filter((x) => !structural.has(x)));
      found.forEach((t) => placedTags.add(t));
      if (found.length) addTags(w.file, found);
    }
    // tag che Claude ha visto ma che non stanno nel testo scritto: nella prima nota, come prima
    const rest = result.tags.map((t) => t.replace(/^#/, "").toLowerCase()).filter((t) => t && !placedTags.has(t) && !structural.has(t));
    if (rest.length) addTags(note, rest);
    for (const { file, tags } of perFile.values()) {
      let added: string[] = [];
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
        const low = cur.map((c) => c.toLowerCase());
        added = [...tags].filter((t) => !low.includes(t));
        if (added.length) fm.tags = [...cur.filter(Boolean), ...added];
      });
      if (added.length) this.log(`Tag aggiunti a "${file.basename}": ${added.map((t) => "#" + t).join(" ")}.`);
    }

    if (checked) this.log(`Spuntati ${checked} task.`);
    if (fixed.length) this.log(`Corretto: "${fixed.join('", "')}".`);
    if (deleted) this.log(`Cancellato (linee sopra le parole): "${result.deleted_text.join('", "')}".`);
    await this.store.markTranscribed(key, [...newSet]);
    const nLines = result.lines.filter((l) => l.text.trim()).length + (joinToPrev ? 1 : 0);
    if (nLines) this.log(`Trascritte ${nLines} righe in "${target.file.basename}".`);
    if (extraNotes.length) this.log(`Note nuove da titoli con doppia sottolineatura: ${extraNotes.map((n) => `"${n}"`).join(", ")}.`);
    if (!nLines && !checked && !deleted && !fixed.length && !extraNotes.length) this.log(`Nessun testo nei tratti nuovi di "${note.basename}" (disegno?).`);
  }
}

/**
 * A quale parte della pagina va un #tag scritto all'altezza `tagY`: al titolo subito sotto (o accanto),
 * altrimenti a quello della parte in cui sta. `doublesY` = altezze delle doppie sottolineature della pagina;
 * le ultime corrispondono, in ordine, ai titoli delle parti dopo la prima. "" se i conti non tornano.
 */
/**
 * Parte della pagina per del testo che comincia all'altezza `topY`: quella del titolo a metà pagina più vicino sopra
 * (0 = la parte in cima). Servono tante doppie sottolineature quante le parti dopo la prima (più quella in cima).
 */
export function pickTextSegment(segIds: string[], doublesY: number[], topY: number): string {
  const ys: number[] = [];
  for (const y of [...doublesY].sort((a, b) => a - b)) if (!ys.length || y - ys[ys.length - 1] > 2) ys.push(y);
  const need = segIds.length - 1;
  if (need < 1 || ys.length < need || ys.length > need + 1) return "";
  const mids = ys.slice(ys.length - need);
  let idx = 0;
  mids.forEach((y, i) => {
    if (y < topY) idx = i + 1;
  });
  return segIds[idx];
}

export function pickTagSegment(segIds: string[], doublesY: number[], tagY: number): string {
  // doppie sottolineature ripassate (più coppie sotto lo stesso titolo): una sola
  const ys: number[] = [];
  for (const y of [...doublesY].sort((a, b) => a - b)) if (!ys.length || y - ys[ys.length - 1] > 2) ys.push(y);
  const need = segIds.length - 1;
  if (need < 1 || ys.length < need || ys.length > need + 1) return "";
  const mids = ys.slice(ys.length - need);
  const below = mids.findIndex((y) => y > tagY && y - tagY <= 6);
  if (below >= 0) return segIds[below + 1];
  let idx = 0;
  mids.forEach((y, i) => {
    if (y < tagY) idx = i + 1;
  });
  return segIds[idx];
}

/** Due titoli quasi uguali (una lettera letta diversa: "Video Kaan" / "Video Kaah"). */
function similar(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  const m = a.length,
    n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n] <= Math.max(1, Math.floor(Math.max(m, n) / 6));
}

/**
 * Sostituisce le parole della lista nera ("violeo") con la parola frequente più simile ("video"),
 * mantenendo la maiuscola iniziale. Se nessuna parola frequente è abbastanza simile, la lascia com'è.
 */
export function fixBlacklisted(text: string, blacklist: string, vocabulary: string): string {
  const black = new Set(blacklist.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean));
  if (!black.size || !text) return text;
  const vocab = vocabulary.split(",").map((w) => w.trim()).filter((w) => w && !/\s/.test(w));
  const dist = (a: string, b: string) => {
    const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return d[b.length];
  };
  return text.replace(/[\p{L}]+/gu, (w) => {
    const low = w.toLowerCase();
    if (!black.has(low)) return w;
    let best = "",
      bd = Infinity;
    for (const v of vocab) {
      const dd = dist(low, v.toLowerCase());
      if (dd < bd) {
        bd = dd;
        best = v;
      }
    }
    if (!best || bd > Math.max(2, Math.floor(low.length / 2))) return w;
    return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? best[0].toUpperCase() + best.slice(1) : best.toLowerCase() === best ? best : best;
  });
}

/** Testo "sciolto" per confrontare titoli e righe (minuscolo, solo lettere e numeri). */
export function looseText(t: string): string {
  return (t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * I #tag dei template scritti nel testo vanno al titolo giusto, mai al testo:
 * - nella prima riga dopo un titolo (accanto o subito sotto): a quel titolo;
 * - nell'ultima riga prima di un titolo (scritti sopra, attaccati alla fine della nota prima): al titolo che segue;
 * - altrove: al titolo della parte in cui stanno.
 * Restituisce i tag rimasti nella parte prima di ogni titolo (da assegnare alla nota della pagina).
 * Non toglie i tag dal testo (lo fa stripTags).
 */
export function assignTemplateTags(
  groups: { title?: string; tag?: string; lines: { text: string }[] }[],
  isTemplate: (tag: string) => boolean
): string[] {
  const leftovers: string[] = [];
  const re = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;
  // un tag noto scritto da solo su una riga (il "#" a mano a volte si perde): "task" sopra un titolo = #task
  const bare = (text: string) => {
    const w = text.replace(/\*\*/g, "").trim().replace(/^[#※✳*×xX]\s*/, "").trim();
    return /^[\p{L}\p{N}_\-/]+$/u.test(w) && isTemplate(w.toLowerCase()) ? w.toLowerCase() : "";
  };
  const found = (text: string) => [...text.matchAll(re)].map((m) => m[2].toLowerCase()).filter(isTemplate);
  groups.forEach((g, k) => {
    // tag scritto prima del titolo, sulla stessa riga
    if (k >= 1 && g.title) {
      for (const tag of found(g.title)) {
        if (!g.tag) g.tag = tag;
        g.title = g.title.replace(new RegExp(`(^|\\s)#${tag}(?=$|\\s)`, "iu"), " ").trim();
      }
    }
    let last = -1;
    for (let i = g.lines.length - 1; i >= 0; i--)
      if (g.lines[i].text.trim()) {
        last = i;
        break;
      }
    g.lines.forEach((l, i) => {
      const next = groups[k + 1];
      const tags = found(l.text);
      // senza "#": vale solo una parola-tag da sola, subito sotto un titolo o subito sopra il titolo seguente
      if (!tags.length) {
        const b = bare(l.text);
        if (b && k >= 1 && i === 0 && !g.tag) {
          g.tag = b;
          l.text = "";
        } else if (b && i === last && next && !next.tag) {
          next.tag = b;
          l.text = "";
        }
        return;
      }
      for (const tag of tags) {
        if (k >= 1 && i === 0 && !g.tag) g.tag = tag;
        else if (i === last && next && !next.tag) next.tag = tag;
        else if ((g.tag === tag && k >= 1) || next?.tag === tag) continue; // già assegnato
        else if (k >= 1 && !g.tag) g.tag = tag;
        else if (k === 0) leftovers.push(tag);
      }
    });
  });
  return [...new Set(leftovers)];
}

/** Toglie dal testo i #tag indicati (es. il tag della pagina); le righe rimaste vuote spariscono. */
export function stripTags<T extends { text: string }>(lines: T[], tags: Set<string>): T[] {
  if (!tags.size) return lines.filter((l) => l.text.trim());
  return lines
    .map((l) => {
      let text = l.text;
      for (const t of tags) {
        const re = new RegExp(`(^|\\s)#${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,.;:!?])`, "giu");
        text = text.replace(re, "$1");
      }
      text = text
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/^\s*[,;:]\s*/, "")
        .trim();
      return { ...l, text };
    })
    .filter((l) => l.text);
}

/** #tag scritti nel testo (non i titoli "# …", non dentro i link): senza #, minuscoli. */
export function inlineTags(md: string): string[] {
  const clean = md.replace(/```[\s\S]*?```/g, " ").replace(/!?\[\[[^\]]*\]\]/g, " ").replace(/`[^`]*`/g, " ");
  return [...new Set([...clean.matchAll(/(?:^|[\s(])#([\p{L}][\p{L}\p{N}_\-/]*)/gu)].map((m) => m[1].toLowerCase()))];
}
