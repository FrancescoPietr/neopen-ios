// The pen → calendar and tasks, all on the phone (PC off, Obsidian closed, phone locked in a pocket).
// When you stop writing (pen off, or two minutes without strokes) the new strokes of each page are drawn and read by
// Claude; what it finds goes straight where the app shows it:
//   - tasks with a time → an event in the iPhone calendar (EventKit);
//   - tasks without a time → the daily note of the vault, under "### Attività" (see core/penInbox.ts).
// Nothing is created twice: similar tasks already in the vault and similar events already in the calendar are skipped,
// and what was created once is remembered (if you delete it, it does not come back).
// The requests go on with the phone locked (BackgroundHttp.swift); their answers arrive with the onHttpDone event.
import { Directory, File, Paths } from "expo-file-system";
import NeoPenBle from "../../modules/neopen-ble";
import { PhoneEvent, PhoneTodo, eventsRequest, localDay, parseTasks, strokesAfter } from "../core/events";
import { keyLabel, PageKey, PageRecord, pageId, Stroke } from "../core/models";
import { addToDaily, dailyPath } from "../core/penInbox";
import { renderNewStrokesPng } from "../core/render";
import { looseTitle, sameTitle } from "../core/similar";
import { PageStore } from "../core/store";
import { toBase64 } from "../core/bytes";
import { parseYmd } from "../core/tasks";
import { agenda } from "./agenda";
import { readJson, writeJson } from "./files";

interface Found {
  page: string;
  /** When the strokes were written (for the daily note and "oggi"/"domani"). */
  writtenAt: number;
  events: PhoneEvent[];
  todos: PhoneTodo[];
}

interface State {
  /** The starting point is set (strokes written before the feature was turned on are read only by «Recupera»). */
  base: boolean;
  /** Per page: pen-down time of the last stroke already read. */
  upTo: Record<string, number>;
  /** Claude requests in flight: request id → page and strokes it covers. */
  reading: Record<string, { page: string; upTo: number; writtenAt: number; recover?: boolean }>;
  /** Found, not yet written (no vault folder or no calendar access yet): written as soon as possible. */
  pending: Found[];
  /** «Recupera»: pages and days still to read (two at a time). */
  queue: { page: string; day: string }[];
  /** What was already created ("e|title|start" or "t|title|day"): never twice. */
  made: string[];
  /** Failed attempts per page (to stop after a few, until you write again). */
  fails: Record<string, number>;
}

const EMPTY: State = { base: false, upTo: {}, reading: {}, pending: [], queue: [], made: [], fails: {} };
const FILE = "telefono-eventi.json";
const plain = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
const isInk = (s: Stroke) => s.tip !== 1 && s.pts.length >= 3;
const realTime = (t: number) => t > 1_000_000_000_000;

export interface PhoneEventsConfig {
  enabled: boolean;
  apiKey: string;
  /** iPhone calendar for the events ("" = the default one). */
  calendarId: string;
}

export class PhoneEvents {
  private state: State = { ...EMPTY, ...readJson<State>(FILE, EMPTY) };
  private idle: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;
  private work: Promise<void> = Promise.resolve();
  private told = new Set<string>();
  private lastFlush = 0;

  constructor(
    private store: PageStore,
    private config: () => PhoneEventsConfig,
    private log: (m: string) => void
  ) {
    // from the versions that sent to Google/Todoist
    const st = this.state as State & { saving?: unknown; retry?: unknown };
    delete st.saving;
    delete st.retry;
    this.state.pending ??= [];
    this.state.queue ??= [];
    this.state.made ??= [];
  }

  private save(): void {
    writeJson(FILE, this.state);
  }

  private dir(): Directory {
    const d = new Directory(Paths.document, "http");
    d.create({ intermediates: true, idempotent: true });
    return d;
  }

  private ready(): boolean {
    const c = this.config();
    return c.enabled && !!c.apiKey.trim();
  }

  /** New strokes arrived: if you stop writing for 2 minutes, the page is read. */
  strokesArrived(): void {
    this.state.fails = {};
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kick(), 120_000);
  }

  /** The pen went off (or you stopped writing): read the pages with new strokes. */
  kick(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.ready()) return;
    if (!this.state.base) {
      // first time: what is already on the pages is read only if you ask («Recupera»)
      for (const r of this.store.pages.values()) this.state.upTo[pageId(r.key)] = Math.max(0, ...r.strokes.map((s) => s.t));
      this.state.base = true;
      this.save();
      this.log("Penna → calendario e attività attivo: da ora quello che scrivi va subito nel calendario e nelle attività.");
      return;
    }
    const busy = new Set(Object.values(this.state.reading).filter((r) => !r.recover).map((r) => r.page));
    for (const r of this.store.pages.values()) {
      const id = pageId(r.key);
      if (busy.has(id) || (this.state.fails[id] ?? 0) >= 3) continue;
      const mark = this.state.upTo[id] ?? 0;
      const fresh = strokesAfter(r, mark);
      if (!fresh.length) continue;
      // the page with the strokes already read in gray: a time added to an old task is read together with it
      const png = renderNewStrokesPng(r.strokes, (st) => st.t > mark);
      if (!png) continue;
      const upTo = Math.max(...fresh.map((s) => s.t));
      const writtenAt = Math.min(...fresh.map((s) => s.t).filter(realTime), Date.now());
      const req = this.askClaude(png, writtenAt);
      if (!req) continue;
      this.state.reading[req] = { page: id, upTo, writtenAt };
      this.save();
      this.log(`${keyLabel(r.key)}: leggo ${fresh.length} tratti nuovi…`);
    }
    this.flush(true);
  }

  /**
   * «Recupera»: reads again everything written on every page, day by day (each day's strokes in black, the earlier
   * ones in gray, like when you wrote them), and adds what is missing from the calendar and the tasks.
   */
  recoverAll(): number {
    if (!this.ready()) return 0;
    const queued = new Set(this.state.queue.map((q) => `${q.page}|${q.day}`));
    let n = 0;
    for (const r of this.store.pages.values()) {
      const id = pageId(r.key);
      const days = [...new Set(r.strokes.filter((s) => isInk(s) && realTime(s.t)).map((s) => localDay(s.t)))].sort();
      for (const day of days) {
        if (queued.has(`${id}|${day}`)) continue;
        this.state.queue.push({ page: id, day });
        n++;
      }
      // from now on the normal reading starts after these strokes
      this.state.upTo[id] = Math.max(this.state.upTo[id] ?? 0, ...r.strokes.map((s) => s.t));
    }
    this.state.base = true;
    this.save();
    if (n) this.log(`Recupero: rileggo ${n} ${n === 1 ? "giorno" : "giorni"} di scrittura (pagina per pagina) e aggiungo quello che manca.`);
    this.pump();
    return n;
  }

  /** «Recupera»: up to two pages-days read at a time. */
  private pump(): void {
    if (!this.ready()) return;
    let running = Object.values(this.state.reading).filter((r) => r.recover).length;
    while (running < 2 && this.state.queue.length) {
      const { page, day } = this.state.queue.shift()!;
      const r = this.record(page);
      if (!r) continue;
      const start = parseYmd(day).getTime();
      const end = start + 86_400_000;
      const strokes = r.strokes.filter((s) => s.t < end);
      const ofDay = (s: Stroke) => s.t >= start && s.t < end;
      const png = renderNewStrokesPng(strokes, ofDay);
      if (!png) continue;
      const writtenAt = Math.min(...strokes.filter((s) => ofDay(s) && isInk(s)).map((s) => s.t));
      const req = this.askClaude(png, writtenAt);
      if (!req) {
        this.state.queue.unshift({ page, day });
        break;
      }
      this.state.reading[req] = { page, upTo: 0, writtenAt, recover: true };
      running++;
    }
    this.save();
  }

  private record(id: string): PageRecord | undefined {
    for (const r of this.store.pages.values()) if (pageId(r.key) === id) return r;
    return undefined;
  }

  private askClaude(png: { bytes: Uint8Array; width: number; height: number }, writtenAt: number): string | null {
    const req = `ev-${Date.now()}-${++this.counter}`;
    const f = new File(this.dir(), `${req}.req`);
    f.create({ overwrite: true });
    f.writeSync(eventsRequest(toBase64(png.bytes), png, writtenAt));
    const ok = NeoPenBle.startBackgroundPost(
      req,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.config().apiKey.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      plain(f.uri)
    );
    return ok ? req : null;
  }

  /** Reads the answers that arrived (also those that arrived while the app was asleep). Call often. */
  poll(): void {
    const dir = this.dir();
    let changed = false;
    for (const [req, info] of Object.entries(this.state.reading)) {
      if (!new File(dir, `${req}.done`).exists) continue;
      changed = true;
      const result = this.take(req);
      delete this.state.reading[req];
      const label = keyLabel(keyOf(info.page));
      const day = info.recover ? ` (${new Date(info.writtenAt).toLocaleDateString("it-IT", { day: "numeric", month: "short" })})` : "";
      if (!result.ok) {
        if (info.recover) {
          this.log(`${label}${day}: lettura non riuscita (${result.error}).`);
          continue;
        }
        this.state.fails[info.page] = (this.state.fails[info.page] ?? 0) + 1;
        this.log(`${label}: lettura non riuscita (${result.error}). ${this.state.fails[info.page] >= 3 ? "Riprovo quando scrivi ancora." : "Riprovo alla prossima."}`);
        continue;
      }
      let found: ReturnType<typeof parseTasks> | null;
      try {
        found = parseTasks(result.body, info.writtenAt);
      } catch {
        found = null;
      }
      if (!found) {
        if (!info.recover) this.state.fails[info.page] = (this.state.fails[info.page] ?? 0) + 1;
        this.log(`${label}${day}: risposta di Claude non leggibile.`);
        continue;
      }
      if (!info.recover) {
        this.state.upTo[info.page] = Math.max(this.state.upTo[info.page] ?? 0, info.upTo);
        delete this.state.fails[info.page];
      }
      if (!found.events.length && !found.todos.length) {
        if (!info.recover) this.log(`${label}: nessuna attività nei tratti nuovi.`);
        continue;
      }
      this.state.pending.push({ page: info.page, writtenAt: info.writtenAt, events: found.events, todos: found.todos });
    }
    if (changed) this.save();
    this.pump();
    this.flush(changed);
  }

  /** Writes what was found into the vault and the calendar (one batch at a time; what is waiting: once a minute). */
  flush(force = false): void {
    if (!this.state.pending.length) return;
    if (!force && Date.now() - this.lastFlush < 60_000) return;
    this.lastFlush = Date.now();
    this.work = this.work.then(() => this.deliverAll()).catch((e) => this.log(`Penna → attività: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async deliverAll(): Promise<void> {
    if (!this.state.pending.length) return;
    // iOS keeps the app awake while the notes and events are written (also with the phone locked)
    const task = NeoPenBle.beginBackgroundTask("penna-attivita");
    const items = this.state.pending;
    this.state.pending = [];
    try {
      const keep: Found[] = [];
      const made = new Set(this.state.made);
      // 1) tasks without a time → daily notes
      const todos = items.filter((f) => f.todos.length);
      if (todos.length) {
        if (!agenda.vaultName()) {
          keep.push(...todos.map((f) => ({ ...f, events: [] })));
          this.tellOnce("vault", "Attività dalla penna in attesa: scegli la cartella del vault (Oggi → Scegli la cartella) e le aggiungo.");
        } else {
          const left = await this.writeTodos(todos, made);
          keep.push(...left);
        }
      }
      // 2) tasks with a time → iPhone calendar
      for (const f of items.filter((x) => x.events.length)) {
        const left = await this.writeEvents(f, made);
        if (left.length) keep.push({ ...f, todos: [], events: left });
      }
      this.state.made = [...made].slice(-3000);
      this.state.pending.push(...keep);
      this.save();
      agenda.changedOutside();
    } catch (e) {
      // nothing is lost: tried again at the next answer or when the app opens
      this.state.pending.unshift(...items);
      this.save();
      throw e;
    } finally {
      NeoPenBle.endBackgroundTask(task);
    }
  }

  private async writeTodos(items: Found[], made: Set<string>): Promise<Found[]> {
    const tasks = await agenda.freshTasks();
    const cfg = agenda.dailyNotes();
    // by day of writing → one write per daily note
    const byDay = new Map<string, { title: string; date: string; page: string }[]>();
    for (const f of items) {
      const day = localDay(f.writtenAt);
      const label = keyLabel(keyOf(f.page));
      for (const t of f.todos) {
        const due = t.date || day;
        const key = `t|${looseTitle(t.title)}|${due}`;
        const there = tasks.find((x) => sameTitle(x.title, t.title) && (!x.date || Math.abs(parseYmd(x.date).getTime() - parseYmd(due).getTime()) <= 3 * 86_400_000));
        if (made.has(key) || there) {
          this.log(`${label}: «${t.title}» c'è già nelle attività.`);
          made.add(key);
          continue;
        }
        const list = byDay.get(day) ?? [];
        if (!list.some((x) => sameTitle(x.title, t.title))) list.push({ ...t, page: label });
        byDay.set(day, list);
      }
    }
    const left: Found[] = [];
    let template: string | null | undefined;
    for (const [day, list] of byDay) {
      const path = dailyPath(cfg, day);
      const text = await NeoPenBle.readVaultFile(path);
      if (text === null && template === undefined) template = await agenda.templateText();
      const next = addToDaily(text, list, day, text === null ? template ?? null : null);
      const err = agenda.writeFile(path, next);
      if (err) {
        this.log(`Non riesco a scrivere «${path}»: ${err}. Riprovo più tardi.`);
        left.push({ page: items[0].page, writtenAt: parseYmd(day).getTime() + 12 * 3_600_000, events: [], todos: list.map(({ title, date }) => ({ title, date })) });
        continue;
      }
      for (const t of list) made.add(`t|${looseTitle(t.title)}|${t.date || day}`);
      const note = path.replace(/\.md$/, "").split("/").pop();
      this.log(`${list.map((t) => `«${t.title}»${t.date && t.date !== day ? ` (📅 ${t.date})` : ""}`).join(", ")} → attività (nota del giorno ${note}).`);
    }
    return left;
  }

  private async writeEvents(f: Found, made: Set<string>): Promise<PhoneEvent[]> {
    const label = keyLabel(keyOf(f.page));
    const left: PhoneEvent[] = [];
    for (const e of f.events) {
      const start = new Date(e.start);
      const key = `e|${looseTitle(e.title)}|${start.toISOString().slice(0, 16)}`;
      if (made.has(key)) continue;
      const when = start.toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const r = await agenda.penEvent({ title: e.title, start, end: e.end ? new Date(e.end) : null, note: `Scritto con la penna (pagina ${label}).` }, this.config().calendarId || null);
      if (r === "noAccess") {
        left.push(e);
        this.tellOnce("cal", "Eventi dalla penna in attesa: apri l'app e consenti l'accesso al calendario (Calendario → Consenti), poi li aggiungo.");
        continue;
      }
      if (r === "created" || r === "exists") {
        made.add(key);
        this.log(r === "created" ? `${label}: «${e.title}» ${when} → calendario.` : `${label}: «${e.title}» ${when} c'è già nel calendario.`);
        continue;
      }
      left.push(e);
      this.log(`${label}: evento «${e.title}» non creato (${r}). Riprovo più tardi.`);
    }
    return left;
  }

  private tellOnce(what: string, message: string): void {
    if (this.told.has(what)) return;
    this.told.add(what);
    this.log(message);
  }

  /** How many things are waiting (for the settings screen). */
  get waiting(): { reading: number; queue: number; pending: number } {
    return { reading: Object.keys(this.state.reading).length, queue: this.state.queue.length, pending: this.state.pending.reduce((n, f) => n + f.events.length + f.todos.length, 0) };
  }

  /** Answer of a finished request; its files are removed. */
  private take(req: string): { ok: boolean; body: string; error?: string } {
    const dir = this.dir();
    const files = ["req", "done", "body"].map((ext) => new File(dir, `${req}.${ext}`));
    let info: { status?: number; error?: string } = {};
    let body = "";
    try {
      info = JSON.parse(files[1].textSync());
      body = files[2].exists ? files[2].textSync() : "";
    } catch {
      /* unreadable: treated as an error */
    }
    for (const f of files) {
      try {
        if (f.exists) f.delete();
      } catch {
        /* leftovers are harmless */
      }
    }
    if (info.error) return { ok: false, body, error: info.error };
    const status = info.status ?? 0;
    if (status < 200 || status >= 300) {
      let msg = `stato ${status}`;
      try {
        msg = JSON.parse(body)?.error?.message ?? msg;
      } catch {
        /* keep the status */
      }
      return { ok: false, body, error: status === 401 ? "chiave di Claude non valida" : msg };
    }
    return { ok: true, body };
  }
}

function keyOf(id: string): PageKey {
  const [section, owner, note, page] = id.split("_").map(Number);
  return { section, owner, note, page };
}
