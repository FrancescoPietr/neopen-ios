// Coda di trascrizione: decide quando trascrivere una pagina, manda solo i tratti nuovi
// e aggiunge il testo alla nota della stessa pagina.

import { App, TFile, normalizePath } from "obsidian";
import { NoteRouter, RoutedNote, wrapPageCallouts } from "../notes/NoteRouter";
import { applyIndents } from "./indent";
import { adoptPhoneTasks } from "../notes/phoneTasks";
import { expandBounds, renderStrokesPng } from "../render/png";
import { PageStore } from "../store/PageStore";
import { PageKey, Stroke, pageId } from "../types";
import { HandwritingRef, TranscribedLine, keepTags, normalizeTaskLine, parseLine, readRowEdit, readTickedTask, transcribeWithClaude } from "./claude";
import { planRowEdits } from "./rowEdits";
import { findTaskBoxes, findTicks, letterHeight, taskLines, writtenRows } from "./ticks";
import { svgToPngBase64 } from "../views/handwriting";
import { alphabetScheme, resolveLang } from "./samples";
import { Canvas, DrawingSpec, PlacedLabel, boxToNcode, canvasFor, drawingLayout, drawingSvg, formatDrawingBlock, isConnector, labelTags, linesAfterBlock, moveAnchor, anchorOf, parseDrawingBlock, placeDrawings, addOrphanLabels, normText, placeLabels } from "./drawings";
import { escapeLabelLine } from "./drawings";
import { DrawingRecord, findExtensions, growInto, reconstructRecord, recordPathOf, sameCanvas } from "./drawingUpdate";
import { addReplyInBlock, replaceLineInBlock, hasBlock, stripLegacyPageSections, BLOCK_END, BLOCK_START, checkTasksInBlock, deleteTextInBlock, linesToMarkdown, readBlock, removeLineInBlock, writeIntoBlock } from "./noteBlock";
import { strokeBounds } from "../render/svg";
import { classifyLines, findReplyArrows, findStrikes, struckStrokes, underlineReport } from "./lineHint";

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
  /** Dove sta sulla carta ogni riga trascritta (lo stesso oggetto delle impostazioni del plugin: si salva con loro). */
  lineRows?: Record<string, { bid: string; text: string; y: number; x0: number; x1: number; inferred?: boolean }[]>;
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

  /** Dove sta sulla carta ogni riga appena scritta nella nota (dai rettangoli delle righe dati da Claude). */
  private recordRows(pid: string, bid: string, lines: TranscribedLine[], png: { ox: number; oy: number; scale: number }): void {
    const rows = this.settings().lineRows;
    if (!rows) return;
    const list = (rows[pid] = rows[pid] ?? []);
    for (const l of lines) {
      if (!l.box || l.kind === "newnote") continue;
      const b = boxToNcode(l.box, png);
      const text = linesToMarkdown([l]).trim();
      if (!b || !text || text.startsWith("```")) continue;
      const y = (b.minY + b.maxY) / 2;
      for (let i = list.length - 1; i >= 0; i--) if (Math.abs(list[i].y - y) < 0.5 && list[i].x0 < b.maxX && b.minX < list[i].x1) list.splice(i, 1);
      list.push({ bid, text, y, x0: b.minX, x1: b.maxX, ...(l.inferredDue ? { inferred: true } : {}) });
    }
  }

  /** Una riga della nota cambiata (o tolta, `to` vuoto): si aggiorna anche la sua posizione sulla carta. */
  private renameRow(pid: string, from: string, to: string): void {
    const list = this.settings().lineRows?.[pid];
    if (!list) return;
    const n = (t: string) => looseText(t.replace(/^\s*- \[[ xX]\]\s*/, "").replace(/^\s*-\s+/, ""));
    for (let i = list.length - 1; i >= 0; i--) {
      if (n(list[i].text) !== n(from)) continue;
      if (to.trim()) list[i].text = to.trim();
      else list.splice(i, 1);
    }
  }

  /** La riga della nota che sta sulla carta all'altezza `y` (registrata quando è stata trascritta), se si sa. */
  private rowAt(pid: string, y: number, x0: number, x1: number, H: number) {
    const list = this.settings().lineRows?.[pid] ?? [];
    return list
      .filter((r) => Math.abs(r.y - y) <= 0.8 * H && r.x0 < x1 + H && x0 - H < r.x1)
      .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
  }

  /**
   * Le righe già trascritte che la scrittura nuova cambia (vedi rowEdits.ts): per ognuna un ritaglio della riga e la
   * riga della nota aggiornata. Restituisce i tratti nuovi sistemati così (il resto va alla trascrizione normale).
   */
  private async editRows(key: PageKey, strokes: Stroke[], toDo: Stroke[]): Promise<Set<Stroke>> {
    const handled = new Set<Stroke>();
    const s = this.settings();
    const visible = strokes.filter((st) => st.tip !== 1 && st.pts.length >= 3);
    const old = visible.filter((st) => st.tx);
    const oldBoxes = findTaskBoxes(old, visible);
    const ticks = new Set(findTicks(toDo, oldBoxes).flatMap((k) => k.strokes));
    const fresh = toDo.filter((st) => !ticks.has(st));
    if (!fresh.length) return handled;
    const edits = planRowEdits(fresh, findStrikes(fresh, visible), old, visible, oldBoxes);
    if (!edits.length) return handled;
    // le righe della nota per questa pagina (testo, task, titoli: non i blocchi dei disegni)
    const lines: { text: string; seg: RoutedNote }[] = [];
    for (const sg of this.router.segmentsOf(key)) {
      let fence = false;
      for (const l of readBlock(await this.app.vault.read(sg.file), sg.blockId).split("\n")) {
        const t = l.trim();
        if (t.startsWith("```")) {
          fence = !fence;
          continue;
        }
        if (fence || !t || t.startsWith("<!--") || t.startsWith(">")) continue;
        lines.push({ text: l, seg: sg });
      }
    }
    if (!lines.length) return handled;
    const writtenAt = Math.min(...fresh.map((st) => st.t).filter((t) => t > 1_000_000_000_000));
    const today = new Date(Number.isFinite(writtenAt) ? writtenAt : Date.now()).toLocaleDateString("sv-SE");
    const H = letterHeight(visible);
    for (const e of edits) {
      const black = new Set<Stroke>([...e.strikes, ...e.added]);
      const red = new Set<Stroke>(e.strikes);
      const all = strokeBounds([...e.old, ...e.strikes, ...e.added]);
      if (!all) continue;
      const focus = { minX: Math.min(all.minX, e.row.x0) - 1, maxX: Math.max(all.maxX, e.row.x1) + 1, minY: all.minY - 0.6, maxY: all.maxY + 0.6 };
      // solo la riga e le sue modifiche: le righe sopra e sotto confondono
      const own = new Set<Stroke>(e.old);
      const png = renderStrokesPng(
        visible.filter((st) => own.has(st) || black.has(st)),
        (st) => black.has(st),
        this.maxForce,
        focus,
        (st) => red.has(st)
      );
      if (!png) continue;
      // quale riga della nota è: si sa dalla posizione registrata quando è stata trascritta; se no la sceglie Claude
      const pid = pageId(key);
      const known = this.rowAt(pid, e.row.yc, e.row.x0, e.row.x1, H);
      const norm = (t: string) => looseText(t.replace(/^\s*- \[[ xX]\]\s*/, "").replace(/^\s*-\s+/, ""));
      const knownLine = known ? lines.find((l) => l.seg.blockId === known.bid && norm(l.text) === norm(known.text)) : undefined;
      try {
        const r = await readRowEdit({
          apiKey: s.apiKey,
          apiBaseUrl: s.apiBaseUrl,
          model: s.model,
          pngBase64: png.base64,
          lines: knownLine ? [knownLine.text] : lines.map((l) => l.text),
          today: `${today} (${new Date(`${today}T12:00:00`).toLocaleDateString("it-IT", { weekday: "long" })})`,
          vocabulary: s.vocabulary,
        });
        this.onSpend(r.cost);
        if (knownLine && (r.line || r.remove)) r.n = 1;
        if (!r.n || (!r.remove && !r.line)) {
          this.log(`Pagina ${key.page}: una modifica su una riga già scritta (${e.why.join(", ")}) ma non trovo la riga nella nota: la trascrivo come testo nuovo.`);
          continue;
        }
        const target = knownLine ?? lines[r.n - 1];
        const indent = /^\s*/.exec(target.text)![0];
        // la riga sparisce solo se le cancellature coprono davvero le sue parole (non solo l'orario o una parola)
        if (r.remove) {
          const boxSet = new Set(findTaskBoxes(e.old, visible).flatMap((b) => b.strokes));
          const words = e.old.filter((st) => !boxSet.has(st));
          const struck = new Set(struckStrokes(e.strikes, visible));
          const covered = words.length ? words.filter((st) => struck.has(st)).length / words.length : 0;
          if (covered < 0.75) {
            this.log(`Pagina ${key.page}: la cancellatura copre solo una parte della riga «${target.text.trim()}»: la riga resta.`);
            if (!r.line) continue;
            r.remove = false;
          }
        }
        let fixed = r.remove ? "" : keepTags(target.text, normalizeTaskLine(r.line.replace(/^\s+/, "")));
        const words = (t: string) =>
          looseText(
            t
              .replace(/^\s*- \[[ xX]\]\s*/, "")
              .replace(/^\s*-\s+/, "")
              .replace(/\s*📅.*$/, "")
              .replace(/(?:^|\s)(?:alle|ore|dalle)?\s*\d{1,2}[:.]\d{2}(?:\s*-\s*\d{1,2}[:.]\d{2})?(?=\s|$)/gi, " ")
              .replace(/(?:^|\s)(?:oggi|domani|dopodomani)(?=\s|$)/gi, " ")
          );
        // senza cancellature le parole della riga restano tutte (si può solo aggiungere)
        if (!r.remove && !e.strikes.length && !words(fixed).includes(words(target.text))) {
          this.log(`Pagina ${key.page}: la riga «${target.text.trim()}» riletta perdeva parole («${fixed}»): la lascio com'è.`);
          continue;
        }
        if (!r.remove && !words(fixed)) {
          this.log(`Pagina ${key.page}: la riga «${target.text.trim()}» riletta restava vuota: la lascio com'è.`);
          continue;
        }
        // cancellatura sulla fine della riga, dove c'è l'orario ("lavoro alle 23:00" → "lavoro"): l'orario va via
        // anche se rileggendo è rimasto
        if (!r.remove && e.strikes.length && !e.added.length) {
          const ot0 = /^\s*- \[[ xX]\] (\d{2}:\d{2})/.exec(target.text)?.[1];
          const firstWordEnd = Math.min(...e.old.map((st) => strokeBounds([st])!.maxX));
          const strikeStart = Math.min(...e.strikes.map((st) => strokeBounds([st])!.minX));
          if (ot0 && fixed.includes(` ${ot0} `) && strikeStart > firstWordEnd + 0.5) {
            fixed = fixed.replace(` ${ot0} `, " ");
            this.log(`«${words(fixed)}»: l'orario ${ot0} era sotto la cancellatura, lo tolgo.`);
          }
        }
        // l'orario tolto: se il giorno l'aveva messo il plugin (orario già passato → domani), torna il giorno della nota
        let inferred = !!known?.inferred && knownLine === target;
        if (inferred && !/^- \[[ xX]\] \d{2}:\d{2}/.test(fixed) && /📅/.test(fixed)) {
          fixed = fixed.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, "");
          inferred = false;
        }
        // un orario appena aggiunto (o cambiato) già passato quando l'hai scritto, senza un giorno: è domani
        const nt = /^- \[[ xX]\] (\d{2}):(\d{2})/.exec(fixed);
        const ot = /^\s*- \[[ xX]\] (\d{2}:\d{2})/.exec(target.text)?.[1];
        if (nt && !/📅/.test(fixed) && ot !== `${nt[1]}:${nt[2]}` && Number.isFinite(writtenAt)) {
          const w = new Date(writtenAt);
          const noteDay = /^(\d{4}-\d{2}-\d{2})$/.exec(target.seg.file.basename)?.[1];
          if ((!noteDay || noteDay === today) && Number(nt[1]) * 60 + Number(nt[2]) + 15 < w.getHours() * 60 + w.getMinutes()) {
            fixed += ` 📅 ${new Date(w.getFullYear(), w.getMonth(), w.getDate() + 1, 12).toLocaleDateString("sv-SE")}`;
            inferred = true;
          }
        }
        const next = r.remove ? "" : indent + fixed;
        await this.app.vault.process(target.seg.file, (c) =>
          r.remove ? removeLineInBlock(c, target.text, target.seg.blockId) : replaceLineInBlock(c, target.text, next, target.seg.blockId).content
        );
        this.renameRow(pid, target.text, next);
        if (known && !r.remove) known.inferred = inferred || undefined;
        if (!r.remove) target.text = next;
        for (const st of black) handled.add(st);
        this.log(r.remove ? `Riga cancellata sulla carta: «${target.text.trim()}».` : `Riga cambiata sulla carta (${e.why.join(", ")}): «${next.trim()}».`);
      } catch (err) {
        this.log(`Modifica di una riga: ${(err as Error)?.message ?? err}`);
      }
    }
    return handled;
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

    // righe già scritte cambiate sulla carta (parole aggiunte sulla stessa riga, correzioni accanto a una cancellatura,
    // orari cancellati, caselle disegnate davanti): ognuna si rilegge da sola e si aggiorna nella nota
    if (hasContext && mode === "new") {
      const handled = await this.editRows(key, page.strokes, toDo);
      if (handled.size) {
        await this.store.markTranscribed(key, [...handled].map((st) => st.t));
        for (const st of handled) st.tx = st.tx ?? Date.now();
        toDo = toDo.filter((st) => !handled.has(st));
        newSet = new Set(toDo.map((st) => st.t));
        if (!toDo.length) return;
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
    // spunte misurate dai tratti: una V o una X su una casella di un task già trascritto (non una cancellatura,
    // non scritta nuova)
    const boxes = hasContext ? findTaskBoxes(visible.filter((st) => !newSet.has(st.t)), visible) : [];
    const ticks = findTicks(toDo, boxes);
    const tickSet = new Set(ticks.flatMap((k) => k.strokes));
    const report = underlineReport(
      toDo.filter((st) => !tickSet.has(st)),
      visible
    );
    const struck = new Set(report.strikes);
    const red = new Set(report.red);
    // le parole nuove cancellate (e le loro linee) non arrivano proprio a Claude: niente da trascrivere per sbaglio
    const gone = new Set<Stroke>([...report.erased, ...report.hidden]);
    // frecce di risposta (da una riga a una scritta più sotto): in blu e numerate, così Claude collega bene
    let arrows = findReplyArrows(
      toDo.filter((st) => !gone.has(st) && !struck.has(st)),
      visible.filter((st) => !gone.has(st)),
      new Set<Stroke>([...struck, ...gone])
    );
    const draw = () => {
      const arrowSet = new Set(arrows.map((a) => a.stroke));
      return renderStrokesPng(
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
    };
    const drawn = draw();
    if (!drawn) return;
    let png = drawn;
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
    const noteFor = (list: typeof arrows) =>
      list.length
      ? ` Measured from the pen strokes: ${list.length === 1 ? "1 reply arrow is" : `${list.length} reply arrows are`} drawn in BLUE and numbered with a blue circle at both ends: arrow N starts next to the line it answers (circle N at the start → "to") and ends at the reply writing (circle N at the end → "text"). Write exactly one replies entry for each blue arrow, in order 1..${list.length}; gray arrows were already handled.`
      : "";
    const arrowNote = noteFor(arrows);
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
    const pxBox = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      `[${Math.round((b.x0 - png.ox) * png.scale)}, ${Math.round((b.y0 - png.oy) * png.scale)}, ${Math.round((b.x1 - png.ox) * png.scale)}, ${Math.round((b.y1 - png.oy) * png.scale)}]`;
    const tickNote = ticks.length
      ? ` Measured from the pen strokes: ${ticks.length === 1 ? "1 new tick is" : `${ticks.length} new ticks are`} on task boxes (${ticks.map((k) => `box at ${pxBox(k.box)}`).join("; ")}). Each one CHECKS the task written to the right of that box on the same line: put each of those tasks in checked_tasks, copied exactly from the already transcribed text. A tick is never a strike-through (never deleted_text) and never new text.`
      : "";
    let hint =
      report.hint +
      tickNote +
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
    const writing = toDo.filter((st) => !struck.has(st) && !gone.has(st) && !tickSet.has(st)).length;
    const silent =
      nothing &&
      !result.drawings.some((d) => d.labels.length) &&
      !result.checked_tasks.length &&
      !result.deleted_text.length &&
      !result.replies.length;
    // due righe della carta (una sotto l'altra) unite in una riga sola: "mangia" sopra "lavoro alle 23:00"
    const rows = writtenRows(
      toDo.filter((st) => !struck.has(st) && !gone.has(st) && !tickSet.has(st)),
      visible
    );
    const joined = result.lines.find((l) => {
      if (!l.box || l.kind === "newnote") return false;
      const b = boxToNcode(l.box, png);
      if (!b) return false;
      return rows.filter((r) => r.yc > b.minY && r.yc < b.maxY && r.x1 > b.minX && r.x0 < b.maxX).length >= 2;
    });
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
    // righe unite: si chiede anche insieme a un altro motivo per riprovare (un solo tentativo in più)
    if (joined && rows.length >= 2) {
      retry = `${retry ? `${retry} ` : ""}IMPORTANT: in your answer the line "${joined.text}" joins two rows of handwriting that are one under the other on the paper. Every row is its own entry in lines, in order from top to bottom: a row that starts with a box is a task, a row without a box is plain text. Never move words (or a time) from one row to another.`;
      this.log(`«${joined.text}»: due righe della carta unite in una. Riprovo la trascrizione…`);
    }
    // risposte "con la freccia" ma nessuna freccia misurata, su una pagina con un disegno: le linee del disegno
    // (raggi, onde, frecce interne) sono state prese per frecce. Le scritte accanto al disegno sono testo accanto.
    // "frecce" misurate che stanno dentro un disegno (il lato di una cinepresa, un raggio): sono tratti del disegno.
    // Si tolgono (niente più blu nell'immagine) e le scritte accanto al disegno restano testo accanto.
    {
      const inDrawing = (p: { x: number; y: number }) =>
        result.drawings.some((d) => {
          const b = boxToNcode(d.box, png);
          return !!b && p.x >= b.minX - 0.6 && p.x <= b.maxX + 0.6 && p.y >= b.minY - 0.6 && p.y <= b.maxY + 0.6;
        });
      const fake = arrows.filter((a) => inDrawing(a.start) && inDrawing(a.end));
      if (fake.length) {
        arrows = arrows.filter((a) => !fake.includes(a));
        const again = draw();
        if (again) png = again;
        hint = hint.replace(arrowNote, noteFor(arrows));
        this.log(`${fake.length === 1 ? "Una «freccia» è" : `${fake.length} «frecce» sono`} dentro un disegno: ${fake.length === 1 ? "è un tratto" : "sono tratti"} del disegno, non una risposta.`);
      }
    }
    const noArrows = () => !arrows.length && result.replies.length > 0 && result.drawings.some((d) => !(d as { existing?: number }).existing);
    if (noArrows()) {
      retry = `${retry ? `${retry} ` : ""}IMPORTANT: measured from the pen strokes there are NO reply arrows on this page: the lines of the drawing are part of the drawing. replies must be []: write every piece of writing in lines, in reading order; lines written beside a drawing go right after "[[drawing N]]" (set text_side and lines_beside).`;
      this.log(`Risposte con la freccia ma nessuna freccia sulla carta (le linee del disegno?): riprovo la trascrizione…`);
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

    // ogni spunta misurata: quale task è, letto sulla sua riga (scelto tra i task ancora da fare della pagina), così
    // la spunta non si perde anche se nella pagina intera Claude non l'ha vista
    if (ticks.length && pageBounds) {
      const open: string[] = [];
      for (const sg of this.router.segmentsOf(key))
        for (const t of taskLines([readBlock(await this.app.vault.read(sg.file), sg.blockId)])) if (!t.done && !open.includes(t.text)) open.push(t.text);
      const near = (a: string, b: string) => {
        const x = looseText(a);
        const y = looseText(b);
        return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
      };
      for (const k of ticks) {
        if (!open.length) break;
        const size = Math.max(k.box.x1 - k.box.x0, k.box.y1 - k.box.y0);
        const tb = strokeBounds(k.strokes)!;
        const row = {
          minX: Math.min(k.box.x0, tb.minX) - 0.5,
          maxX: pageBounds.maxX,
          // la riga della casella (le lettere che scendono comprese), non quella sopra
          minY: Math.max(Math.min(k.box.y0 - 0.25 * size, tb.minY), k.box.y0 - 0.6 * size),
          maxY: Math.max(k.box.y1 + 0.6 * size, Math.min(tb.maxY, k.box.y1 + 1.2 * size)),
        };
        const crop = renderStrokesPng(
          page.strokes.filter((st) => !gone.has(st)),
          (st) => k.strokes.includes(st),
          this.maxForce,
          row
        );
        if (!crop) continue;
        // la riga della casella è registrata: si sa già quale task è
        const known = this.rowAt(pageId(key), (k.box.y0 + k.box.y1) / 2, k.box.x0, pageBounds.maxX, letterHeight(visible));
        const knownTask = known && /^- \[ \]/.test(known.text) ? open.find((o) => near(o, known.text.replace(/^- \[ \]\s*/, ""))) : undefined;
        if (knownTask) {
          open.splice(open.indexOf(knownTask), 1);
          const same = result.checked_tasks.findIndex((c) => near(c, knownTask));
          if (same >= 0) result.checked_tasks[same] = knownTask;
          else {
            result.checked_tasks.push(knownTask);
            this.log(`Spunta su «${knownTask}» (la casella è sulla sua riga).`);
          }
          continue;
        }
        try {
          const r = await readTickedTask({ apiKey: s.apiKey, apiBaseUrl: s.apiBaseUrl, model: s.model, pngBase64: crop.base64, candidates: open });
          result.usage.cost += r.cost;
          if (!r.task) {
            this.log(`Spunta sulla casella ${k.index + 1} della pagina: sulla riga non riconosco un task da fare.`);
            continue;
          }
          open.splice(open.indexOf(r.task), 1);
          // la riga esatta della nota al posto della copia di Claude (che può avere una casella o parole in più)
          const same = result.checked_tasks.findIndex((c) => near(c, r.task));
          if (same >= 0) {
            result.checked_tasks[same] = r.task;
            continue;
          }
          result.checked_tasks.push(r.task);
          this.log(`Spunta su «${r.task}» (misurata sulla casella, Claude nella pagina intera non l'aveva vista).`);
        } catch (e) {
          this.log(`Spunta sulla casella ${k.index + 1}: ${(e as Error)?.message ?? e}`);
        }
      }
      // una spunta non cancella mai il suo task
      result.deleted_text = result.deleted_text.filter((d) => !result.checked_tasks.some((c) => near(c, d)));
    }

    // se insiste: le "risposte" restano testo, sotto la riga a cui le collegava (o in fondo)
    if (noArrows()) {
      for (const r of result.replies) {
        let at = result.lines.findIndex((l) => looseText(l.text) && looseText(l.text) === looseText(r.to));
        const line: TranscribedLine = { kind: "text", text: r.text, checked: false, due: "" };
        // la riga è subito prima di un disegno con scritte accanto: è la prima di quelle scritte
        if (at >= 0 && /^\[\[drawing \d+\]\]$/.test(result.lines[at + 1]?.text.trim() ?? "")) at++;
        if (at >= 0) result.lines.splice(at + 1, 0, line);
        else result.lines.push(line);
      }
      this.log(`Nessuna freccia sulla carta: ${result.replies.length === 1 ? "la «risposta» resta testo" : `le ${result.replies.length} «risposte» restano testo`}.`);
      result.replies = [];
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

    // "aereo alle 13:00" scritto alle 22:40 senza un giorno: è domani (un orario già passato oggi non è un impegno)
    if (Number.isFinite(writtenAt)) {
      const w = new Date(writtenAt);
      const nowMin = w.getHours() * 60 + w.getMinutes();
      for (const l of result.lines) {
        if (l.kind !== "task" || l.due || !l.time) continue;
        const [h, m] = l.time.split(":").map(Number);
        if (h * 60 + m + 15 >= nowMin) continue;
        const d = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 1, 12);
        l.due = d.toLocaleDateString("sv-SE");
        l.inferredDue = true;
        this.log(`«${l.text}» alle ${l.time}: quell'ora oggi era già passata quando l'hai scritto, è per domani (${l.due}).`);
      }
    }
    // una casella nuova è spuntata solo se sulla carta c'è davvero il segno dentro (Claude a volte la vede spuntata
    // per le spunte delle righe vicine)
    // Le caselle nuove si guardano sulla carta: una V o una X dentro (o sulla) casella = spuntata, vuota = da fare.
    // Ogni riga del risultato va con la casella alla sua altezza (dal rettangolo della riga dato da Claude).
    {
      const newBoxes = findTaskBoxes(toDo, visible);
      const boxStrokes = new Set(newBoxes.flatMap((b) => b.strokes));
      const marks = findTicks(
        toDo.filter((st) => !boxStrokes.has(st)),
        newBoxes
      );
      const tickedBoxes = new Set([...marks.map((k) => k.box), ...newBoxes.filter((b) => b.ticked)]);
      const H = letterHeight(visible);
      let fixed = 0;
      for (const l of result.lines) {
        if (l.kind !== "task" || !l.box) continue;
        const lb = boxToNcode(l.box, png);
        if (!lb) continue;
        const cy = (lb.minY + lb.maxY) / 2;
        const box = newBoxes
          .filter((b) => Math.abs((b.y0 + b.y1) / 2 - cy) <= 1.0 * H && b.x0 < lb.minX + 2 * H)
          .sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - cy) - Math.abs((b.y0 + b.y1) / 2 - cy))[0];
        if (!box) continue;
        const want = tickedBoxes.has(box);
        if (l.checked !== want) fixed++;
        l.checked = want;
      }
      if (fixed) this.log(`Caselle nuove guardate sulla carta: ${fixed} ${fixed === 1 ? "corretta" : "corrette"} (spuntata o da fare).`);
      // righe senza rettangolo: spuntate solo se sulla carta c'è almeno un segno in una casella nuova
      const claimed = result.lines.filter((l) => l.kind === "task" && l.checked && !l.box);
      if (claimed.length && !tickedBoxes.size) {
        for (const l of claimed) l.checked = false;
        this.log(`${claimed.map((l) => `«${l.text}»`).join(", ")}: nessun segno nella casella sulla carta, da fare.`);
      }
    }

    // "aereo domani alle 14:20" → task "aereo", 📅 domani, ore 14:20: le parole della data e dell'orario non restano nel titolo
    for (const l of result.lines) {
      if (l.kind !== "task") continue;
      let t = l.text;
      if (l.time) t = t.replace(/(^|\s)(?:alle|ore|dalle)\s*$/i, "$1").replace(/(^|\s)(?:alle|ore|dalle)(?=\s)/i, "$1");
      if (l.due) t = t.replace(/(^|\s)(?:oggi|domani|dopodomani)(?=\s|$)/i, "$1");
      t = t.replace(/\s{2,}/g, " ").trim();
      if (t) l.text = t;
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

    // "#taccuino" da solo su una riga e subito sotto parole sottolineate (anche con una linea sola, in grassetto):
    // è il titolo di una nota nuova di quel tipo, come con la doppia sottolineatura
    for (let i = 0; i + 1 < result.lines.length; i++) {
      const tagLine = result.lines[i];
      const raw = tagLine.text.trim();
      // "#taccuino", "# taccuino", o una riga "intestazione" fatta della sola parola del tag
      const m = /^#\s?([\p{L}\p{N}_\-/]+)$/u.exec(raw) ?? (tagLine.kind === "heading" ? /^([\p{L}\p{N}_\-/]+)$/u.exec(raw) : null);
      if (!m || tagLine.kind === "task" || tagLine.kind === "newnote" || !this.router.ruleFor(m[1].toLowerCase())) continue;
      const next = result.lines[i + 1];
      const bold = /^\*\*(.+?)\*\*$/.exec(next.text.trim());
      const title = next.kind === "heading" ? next.text.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim() : bold?.[1].trim();
      if (!title || next.kind === "task" || next.kind === "newnote") continue;
      result.lines.splice(i, 2, { kind: "newnote", text: this.router.fixTitle(title), checked: false, due: "", time: "", tag: m[1].toLowerCase() });
      this.log(`«#${m[1]}» sopra «${title}» sottolineato: è una nota nuova.`);
    }

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

    // Pagina nuova che comincia con un titolo (niente testo prima): quel titolo è il titolo della pagina, così non
    // nasce una nota «Quaderno N - pagina M» vuota
    // (sopra il titolo può esserci solo il suo #tag: "#cinema" e sotto "Cortometraggio" sottolineato due volte)
    const tagsOnly = (t: string) => !t.replace(/#[\p{L}\p{N}_\-/]+/gu, "").replace(/[*\s#]/g, "");
    if (!routed && !result.page_title && !this.router.isContinuation(key) && groups.length > 1 && groups[0].lines.every((l) => tagsOnly(l.text))) {
      const above = groups[0].lines.flatMap((l) => [...l.text.matchAll(/#([\p{L}\p{N}_\-/]+)/gu)].map((m) => m[1].toLowerCase()));
      const first = groups.splice(1, 1)[0];
      result.page_title = first.title ?? "";
      const tag = first.tag || above.find((t) => this.router.ruleFor(t)) || "";
      if (tag && !result.page_tag) result.page_tag = tag;
      groups[0].lines = first.lines;
      this.log(`Pagina ${key.page}: comincia con il titolo «${result.page_title}», è il titolo della pagina.`);
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
    // La nota della pagina non c'è (mai fatta, o cancellata da te) e in cima alla pagina non c'è niente da metterci
    // (solo spunte, cancellature, testo sotto un titolo a metà pagina): non si crea una nota «Quaderno N - pagina M»
    // vuota, si lavora nelle altre parti della pagina.
    const homeEmpty = groups[0].lines.every((l) => tagsOnly(l.text)) && !result.page_title && !result.page_tag;
    const otherParts = routed ? [] : this.router.segmentsOf(key);
    if (!routed && homeEmpty && otherParts.length) {
      routed = otherParts[0];
      this.log(`Pagina ${key.page}: niente da scrivere nella nota della pagina, lavoro solo nelle sue parti (${otherParts.map((p) => `"${p.file.basename}"`).join(", ")}).`);
    } else if (!routed) {
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

    // Cancellato solo l'orario di un appuntamento ("lavoro alle 23:00" con "alle 23:00" cancellato): l'inizio della
    // riga resta, quindi il task resta, senza orario (torna un'attività). Non si toglie la riga intera.
    if (result.deleted_text.length && report.red.length) {
      const boxStrokes = new Set(boxes.flatMap((b) => b.strokes));
      const old = visible.filter((st) => !newSet.has(st.t) && !gone.has(st) && !boxStrokes.has(st));
      const heights = old.map((st) => strokeBounds([st])!).map((b) => b.maxY - b.minY).filter((h) => h > 0.3 && h < 4).sort((a, b) => a - b);
      const H = heights.length ? heights[Math.floor(heights.length / 2)] : 1.2;
      const partial = report.red.every((r) => {
        const rb = strokeBounds([r])!;
        const left = old.filter((st) => {
          const b = strokeBounds([st])!;
          const cy = (b.minY + b.maxY) / 2;
          // le lettere della riga a sinistra della cancellatura, non toccate da lei
          return cy > rb.minY - 0.3 * H && cy < rb.maxY + 0.3 * H && b.maxX < rb.minX + 0.2 * H && b.maxX > rb.minX - 12 * H;
        });
        if (left.length < 2) return false;
        const lb = strokeBounds(left)!;
        return lb.maxX - lb.minX >= 1.5 * H;
      });
      if (partial) {
        // solo l'orario tra le parole cancellate ("alle 23:00"): la riga con quell'orario nella nota
        const bare = /^(?:alle|ore|dalle|h)?\s*(\d{1,2})[:.](\d{2})$/i;
        for (const d of [...result.deleted_text]) {
          const m = bare.exec(d.trim());
          if (!m) continue;
          const hm = `${m[1].padStart(2, "0")}:${m[2]}`;
          for (const sg of this.router.segmentsOf(key)) {
            const line = readBlock(await this.app.vault.read(sg.file), sg.blockId)
              .split("\n")
              .find((l) => new RegExp(`^\\s*- \\[[ xX]\\] ${hm}\\s`).test(l));
            if (line) {
              result.deleted_text = result.deleted_text.map((x) => (x === d ? line.trim() : x));
              break;
            }
          }
        }
        // Claude ha indicato le parole che restano (o la riga intera): la riga del task nella nota con quelle parole
        const taskWords = (l: string) =>
          looseText(l.replace(/^\s*(?:-\s*)?\[[ xX]\]\s*/, "").replace(/^\d{1,2}[:.]\d{2}(?:\s*-\s*\d{1,2}[:.]\d{2})?\s+/, "").replace(/\s*📅.*$/, ""));
        const noteLines: string[] = [];
        for (const sg of this.router.segmentsOf(key)) noteLines.push(...readBlock(await this.app.vault.read(sg.file), sg.blockId).split("\n"));
        for (const d of [...result.deleted_text]) {
          const w = taskWords(d);
          if (!w) continue;
          const line = noteLines.find((l) => /^\s*- \[[ xX]\]/.test(l) && taskWords(l) === w);
          if (!line) continue;
          if (/^\s*- \[[ xX]\]\s*\d{1,2}:\d{2}/.test(line)) result.deleted_text = result.deleted_text.map((x) => (x === d ? line.trim() : x));
          else {
            // un task senza orario con l'inizio della riga non cancellato: le sue parole restano
            result.deleted_text = result.deleted_text.filter((x) => x !== d);
            this.log(`Non cancello «${d}»: la cancellatura copre solo la fine della riga.`);
          }
        }
        const timed = /^\s*(?:-\s*)?\[([ xX])\]\s*(\d{1,2}[:.]\d{2}(?:\s*-\s*\d{1,2}[:.]\d{2})?)\s+(.+)$/;
        for (const d of [...result.deleted_text]) {
          const m = timed.exec(d.trim()) ?? timed.exec(`[ ] ${d.trim()}`);
          if (!m) continue;
          const rest = m[3].replace(/\s*📅.*$/, "").replace(/\s*(?:alle|ore|dalle)\s*$/i, "").trim();
          const due = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(m[3])?.[1];
          if (!rest) continue;
          result.deleted_text = result.deleted_text.filter((x) => x !== d);
          result.corrections.push({ old_line: d, new_line: `[${m[1]}] ${rest}${due ? ` 📅 ${due}` : ""}` });
          this.log(`«${rest}»: cancellato solo l'orario (${m[2]}), resta come attività.`);
        }
      }
    }

    // Una riga già scritta che ora diventa un task o prende un orario (casella disegnata prima di "mangia", "alle 23:00"
    // aggiunto dopo): si aggiorna quella riga, non se ne aggiunge un'altra
    const upgrades: { old: string; md: string; seg: string }[] = [];
    if (!force) {
      const words = (t: string) =>
        looseText(
          t
            .replace(/^\s*- \[[ xX]\]\s*/, "")
            .replace(/^\s*-\s+/, "")
            .replace(/^\d{1,2}[:.]\d{2}(?:-\d{1,2}[:.]\d{2})?\s+/, "")
            .replace(/\s*📅.*$/, "")
            .replace(/\s*(?:alle|ore|dalle)\s*\d{1,2}(?:[:.]\d{2})?\s*$/i, "")
        );
      for (const sg of segs) {
        const have = readBlock(await this.app.vault.read(sg.file), sg.blockId).split("\n");
        for (const l of [...result.lines]) {
          if (l.kind !== "task") continue;
          const w = words(l.text);
          if (w.length < 3) continue;
          const old = have.find((x) => {
            if (!x.trim() || words(x) !== w) return false;
            const isTask = /^\s*- \[[ xX]\]/.test(x);
            const hasTime = /^\s*- \[[ xX]\]\s*\d{1,2}:\d{2}/.test(x);
            return !isTask || (!hasTime && !!l.time);
          });
          if (!old) continue;
          // solo se è la stessa riga sulla carta: "aereo" scritto di nuovo più sotto è un task nuovo
          const rec = (this.settings().lineRows?.[pid] ?? []).find((r) => r.bid === sg.blockId && words(r.text) === words(old));
          const lb = l.box ? boxToNcode(l.box, png) : null;
          if (rec && lb && Math.abs(rec.y - (lb.minY + lb.maxY) / 2) > 0.8 * letterHeight(visible)) continue;
          result.lines.splice(result.lines.indexOf(l), 1);
          upgrades.push({ old, md: linesToMarkdown([l]), seg: sg.blockId });
          this.renameRow(pid, old, linesToMarkdown([l]));
          this.log(`«${old.trim()}» → «${linesToMarkdown([l])}» (casella o orario aggiunti sulla carta).`);
        }
      }
    }
    // 1) testo nuovo nella sua parte della pagina. Una riga identica a una già presente in quel blocco è una rilettura
    //    del testo grigio (Claude l'ha riscritta): non si duplica.
    if (!force && result.lines.length) {
      const have = new Set(
        readBlock(await this.app.vault.read(target.file), target.blockId)
          .split("\n")
          .map((l) => {
            // con l'orario: "lavoro" scritto di nuovo su una riga nuova non è "23:00 lavoro" riletto
            const time = /^\s*- \[[ xX]\]\s*(\d{1,2}:\d{2})/.exec(l)?.[1] ?? "";
            const words = looseText(
              l
                .replace(/^\s*- \[[ xX]\]\s*/, "")
                .replace(/^\s*-\s+(↳\s*)?/, "")
                .replace(/^\d{1,2}:\d{2}(-\d{1,2}:\d{2})?\s+/, "")
                .replace(/\s*📅.*$/, "")
            );
            return words.length >= 4 ? `${words}|${time}` : "";
          })
          .filter(Boolean)
      );
      const before = result.lines.length;
      result.lines = result.lines.filter((l) => l.kind === "newnote" || !have.has(`${looseText(l.text)}|${(l.time ?? "").slice(0, 5)}`));
      if (result.lines.length < before) this.log(`Pagina ${key.page}: ${before - result.lines.length} righe già presenti nella nota, non le ripeto.`);
    }
    // task che il telefono aveva già messo nella nota del giorno: la trascrizione prende il loro posto
    // (in tutte le parti della pagina: anche i task sotto un titolo a metà pagina, es. "#task Task")
    if (!force) await adoptPhoneTasks(this.app, [...result.lines, ...groups.slice(1).flatMap((g) => g.lines)], (m) => this.log(`Pagina ${key.page}: ${m}`));
    const md = linesToMarkdown(result.lines);
    this.recordRows(pid, target.blockId, result.lines, png);
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
      // "[ ] 13:20 aereo", "- [x] pane": la casella copiata da Claude non fa parte del testo del task
      let toCheck = result.checked_tasks.map((t) => t.replace(/^\s*(?:-\s*)?\[[ xX✓✔]?\]\s*/, "").trim()).filter(Boolean);
      for (const fuzzy of [false, true]) {
        for (const sg of segs) {
          if (!toCheck.length && (fuzzy || (!result.deleted_text.length && !pendingFix.length && !upgrades.length))) break;
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
            for (const u of upgrades.filter((x) => x.seg === sg.blockId && !fuzzy)) {
              const r = replaceLineInBlock(next, u.old, u.md, sg.blockId);
              if (r.found) next = r.content;
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
      const gLines = g.lines;
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
      this.recordRows(pid, seg.blockId, gLines, png);
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
    // le immagini della pagina nelle note toccate: nel riquadro chiuso «Pagina N», non a grandezza piena
    for (const f of new Set(written.map((w) => w.file))) await this.app.vault.process(f, (c) => wrapPageCallouts(c));
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
