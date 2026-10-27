// The agenda: tasks from the Obsidian vault (markdown) + events from the iPhone calendars (EventKit, like Fantastical).
// Everything else in the app reads it through useAgenda().
import * as Cal from "expo-calendar";
import { AppState } from "react-native";
import NeoPenBle from "../../modules/neopen-ble";
import { QuickAdd } from "../core/quickadd";
import { DailyNotesConfig } from "../core/penInbox";
import { looseTitle, sameTitle } from "../core/similar";
import { DailyConfig, TaskEdit, appendTask, buildIndex, deleteTask, editTask, toggleTask } from "../core/taskStore";
import { readJson, readText, writeJson, writeText } from "./files";
import { FollowChange, PenTimed, diffPenTimed, isPenAppointment, penBlockLines, penTimedTasks } from "../core/follow";
import { VaultTask, ymd } from "../core/tasks";

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  location: string | null;
  recurring: boolean;
}

export interface CalInfo {
  id: string;
  title: string;
  color: string;
  writable: boolean;
}

export interface AgendaSnapshot {
  vaultName: string | null;
  /**
   * The tasks to show. The tasks written with the pen with a date and a time are appointments: they live in the
   * calendar (as events), not among the tasks (as with the plugin and Google Calendar).
   */
  tasks: VaultTask[];
  loading: boolean;
  error: string | null;
  calendarAccess: "unknown" | "granted" | "denied";
  calendars: CalInfo[];
  /** Events by day (YYYY-MM-DD) for the days loaded so far. */
  events: Record<string, CalEvent[]>;
  /** Changes at every refresh (for lists). */
  version: number;
  /** Changes when the loaded events are thrown away (calendar changed): screens load their days again. */
  eventsEpoch: number;
}

/**
 * Tasks you add in the app with + stay in the app (not in the vault): a markdown file of their own on the phone,
 * read and edited exactly like the notes of the vault.
 */
export const APP_FILE = "@app/Attività.md";
const APP_DOC = "attivita-app.md";
const readAny = async (path: string) => (path === APP_FILE ? readText(APP_DOC) : NeoPenBle.readVaultFile(path));
const writeAny = (path: string, text: string) => (path === APP_FILE ? writeText(APP_DOC, text) : NeoPenBle.writeVaultFile(path, text));
export const isAppTask = (t: { file: string }) => t.file === APP_FILE;

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));
/** The last reading of the timed tasks written with the pen (to see what changed in the notes). */
const FOLLOW_FILE = "penna-orari.json";

class Agenda {
  private snap: AgendaSnapshot = { vaultName: null, tasks: [], loading: false, error: null, calendarAccess: "unknown", calendars: [], events: {}, version: 0, eventsEpoch: 0 };
  private listeners = new Set<() => void>();
  private files = new Map<string, { mtime: number; text: string }>();
  /** All the tasks of the vault, appointments written with the pen included. */
  private all: VaultTask[] = [];
  private daily: DailyConfig = { folder: "Daily", format: "YYYY-MM-DD" };
  private template = "";
  private loadedRanges: [number, number][] = [];
  private started = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<AgendaSnapshot>): void {
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    for (const fn of this.listeners) fn();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    void this.initCalendar(false);
    // back to the app: files may have changed in Obsidian, events in the Calendar app
    AppState.addEventListener("change", (s) => {
      if (s === "active") {
        void this.refresh();
        this.dropEvents();
      }
    });
  }

  // ---------------------------------------------------------------- vault

  vaultName(): string | null {
    try {
      return NeoPenBle.vaultFolderName();
    } catch {
      return null;
    }
  }

  async pickVault(): Promise<void> {
    const name = await NeoPenBle.pickVaultFolder();
    if (name) {
      this.files.clear();
      await this.refresh();
    }
  }

  /** Reads the vault again (only the files that changed). */
  async refresh(): Promise<void> {
    const vaultName = this.vaultName();
    const local = readText(APP_DOC);
    if (local !== null) this.files.set(APP_FILE, { mtime: Date.now(), text: local });
    if (!vaultName) {
      for (const p of [...this.files.keys()]) if (p !== APP_FILE) this.files.delete(p);
      this.set({ vaultName: null });
      this.rebuild(null);
      return;
    }
    this.set({ loading: true, vaultName });
    try {
      const cfg = await NeoPenBle.readVaultFile(".obsidian/daily-notes.json");
      if (cfg) {
        try {
          const j = JSON.parse(cfg);
          this.daily = { folder: String(j.folder ?? ""), format: String(j.format || "YYYY-MM-DD") };
          this.template = String(j.template ?? "");
        } catch {
          /* default */
        }
      }
      await this.readTags();
      const list = await NeoPenBle.listVaultMarkdown();
      const seen = new Set<string>();
      for (const f of list) {
        seen.add(f.path);
        const cur = this.files.get(f.path);
        if (cur && cur.mtime === f.mtime) continue;
        const text = await NeoPenBle.readVaultFile(f.path);
        if (text !== null) this.files.set(f.path, { mtime: f.mtime, text });
      }
      for (const p of [...this.files.keys()]) if (!seen.has(p) && p !== APP_FILE) this.files.delete(p);
      this.rebuild(null);
      void this.syncDoneEvents();
      this.followPen();
    } catch (e) {
      this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private rebuild(error: string | null): void {
    const files = [...this.files.entries()].map(([path, f]) => ({ path, text: f.text }));
    this.all = buildIndex(files, this.daily);
    const blocks = penBlockLines(files.filter((f) => f.path !== APP_FILE));
    this.set({ tasks: this.all.filter((t) => !isPenAppointment(t, blocks)), loading: false, error });
  }

  /** The tasks to show (without the appointments written with the pen, which are in the calendar). */
  visible(tasks: VaultTask[]): VaultTask[] {
    const shown = new Set(this.snap.tasks.map((t) => t.id));
    return tasks === this.all ? this.snap.tasks : tasks.filter((t) => shown.has(t.id));
  }

  /** Applies an edit to a file and writes it into the vault. */
  private async change(path: string, edit: (text: string | null) => string | null): Promise<boolean> {
    const fresh = await readAny(path);
    const next = edit(fresh);
    if (next === null) {
      // the file changed (e.g. in Obsidian): read everything again and let the user retry
      await this.refresh();
      this.set({ error: "La nota è cambiata nel frattempo: riprova." });
      return false;
    }
    const err = writeAny(path, next);
    if (err) {
      this.set({ error: `Non riesco a scrivere «${path}»: ${err}` });
      return false;
    }
    this.files.set(path, { mtime: Date.now(), text: next });
    this.rebuild(null);
    return true;
  }

  /** Ticks or unticks a task; a task with a time also marks its calendar event (✓ in front, like before on Google). */
  toggle = async (t: VaultTask): Promise<boolean> => {
    const ok = await this.change(t.file, (text) => (text === null ? null : toggleTask(text, t, ymd(new Date()))));
    if (ok && t.time && t.date) {
      const [h, m] = t.time.split(":").map(Number);
      const [y, mo, d] = t.date.split("-").map(Number);
      void this.setEventDone(t.title, new Date(y, mo - 1, d, h, m), t.time, !t.done, 0);
    }
    return ok;
  };
  edit = (t: VaultTask, e: TaskEdit) => this.change(t.file, (text) => (text === null ? null : editTask(text, t, e)));
  remove = (t: VaultTask) => this.change(t.file, (text) => (text === null ? null : deleteTask(text, t, this.all)));

  /** New task added in the app: it stays in the app (not in the vault). */
  addTask = (q: QuickAdd) => this.change(APP_FILE, (text) => appendTask(text, { ...q, labels: q.labels }, "Attività"));

  obsidianLink(path: string): string {
    const vault = this.snap.vaultName ?? "";
    return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
  }

  // ---------------------------------------------------------------- what the pen writes (see phoneEvents.ts)

  /** The vault read again (only what changed), with its tasks: to check a pen task is not there already. */
  async freshTasks(): Promise<VaultTask[]> {
    await this.refresh();
    return this.all;
  }

  /** Daily notes settings of the vault (from the last read). */
  dailyNotes(): DailyNotesConfig {
    return { ...this.daily, template: this.template };
  }

  /** Text of the daily-note template, or null. */
  async templateText(): Promise<string | null> {
    if (!this.template) return null;
    const p = this.template.replace(/^\/+/, "");
    return (await NeoPenBle.readVaultFile(p.endsWith(".md") ? p : `${p}.md`)) ?? null;
  }

  /** Writes a file the phone changed in the vault and updates the lists. Returns "" or the error. */
  writeFile(path: string, text: string): string {
    const err = NeoPenBle.writeVaultFile(path, text);
    if (!err) {
      this.files.set(path, { mtime: Date.now(), text });
      this.rebuild(null);
    }
    return err;
  }

  /**
   * A task with a time written with the pen → event in the iPhone calendar (`calendarId`, or the default one).
   * Not created if a similar event is already there (any calendar, within an hour and a half).
   */
  async penEvent(e: { title: string; start: Date; end: Date | null; note: string }, calendarIds: string[]): Promise<"created" | "exists" | "noAccess" | string> {
    try {
      const p = await Cal.getCalendarPermissions();
      if (!p.granted) return "noAccess";
      const all = await Cal.getCalendars(Cal.EntityTypes.EVENT);
      const from = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate());
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
      const near = await Cal.listEvents(all.map((c) => c.id), from, to);
      const similar = (x: (typeof near)[number]) => sameTitle(x.title ?? "", e.title) && Math.abs(toDate(x.startDate).getTime() - e.start.getTime()) <= 90 * 60000;
      const targets = calendarIds.filter((id) => all.some((c) => c.id === id && c.allowsModifications));
      const end = e.end && e.end > e.start ? e.end : new Date(e.start.getTime() + 60 * 60000);
      if (!targets.length) {
        // the default calendar: not created if a similar event is in any calendar
        if (near.some(similar)) return "exists";
        await Cal.getDefaultCalendarSync().createEvent({ title: e.title, startDate: e.start, endDate: end, notes: e.note });
      } else {
        // each chosen calendar gets it (unless it already has it)
        let made = 0;
        for (const id of targets) {
          if (near.some((x) => x.calendarId === id && similar(x))) continue;
          await (await Cal.ExpoCalendar.get(id)).createEvent({ title: e.title, startDate: e.start, endDate: end, notes: e.note });
          made++;
        }
        if (!made) return "exists";
      }
      this.dropEvents();
      return "created";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private doneSynced = new Set<string>();

  /**
   * Tasks with a time ticked elsewhere (in Obsidian, or by the plugin from the paper): their calendar event gets the ✓
   * too. Only the last two weeks and the coming month; each task once.
   */
  private async syncDoneEvents(): Promise<void> {
    if (this.snap.calendarAccess !== "granted") return;
    const from = ymd(new Date(Date.now() - 14 * 86_400_000));
    const to = ymd(new Date(Date.now() + 31 * 86_400_000));
    for (const t of this.all) {
      if (!t.done || !t.time || !t.date || t.date < from || t.date > to) continue;
      const key = `${t.file}|${t.title}|${t.date}|${t.time}`;
      if (this.doneSynced.has(key)) continue;
      this.doneSynced.add(key);
      const [h, m] = t.time.split(":").map(Number);
      const [y, mo, d] = t.date.split("-").map(Number);
      await this.setEventDone(t.title, new Date(y, mo - 1, d, h, m), t.time, true, 0);
    }
  }

  /**
   * A task ticked on the paper: the open task with that title (the nearest in time) is ticked in the vault, and the
   * event with that title gets "✓ " in front of its name. Returns what was marked.
   */
  async penTick(title: string, time: string, writtenAt: Date): Promise<{ task: string | null; event: string | null }> {
    const tasks = await this.freshTasks();
    const day = writtenAt.getTime();
    const dist = (t: VaultTask) => (t.date ? Math.abs(new Date(t.date + "T12:00").getTime() - day) : 30 * 86_400_000);
    const open = tasks
      // a recurring task: only the copy that was due by then (an old tick never ticks next week's)
      .filter((t) => !t.done && sameTitle(t.title, title) && (!time || !t.time || t.time === time) && (!t.recurrence || !t.date || t.date <= ymd(writtenAt)))
      .sort((a, b) => dist(a) - dist(b));
    let task: string | null = null;
    if (open.length && (await this.toggle(open[0]))) task = open[0].file;
    // the event (also when the task is not in the vault yet)
    const event = open.length && open[0].time ? null : await this.setEventDone(title, writtenAt, time, true, 14);
    return { task, event: event ?? (open.length && open[0].time ? "con l'attività" : null) };
  }

  /**
   * Marks an event done ("✓ title") or not. It looks around `near` (± `days`, the same day if 0) in the writable
   * calendars for an event with that title (and that time, if given). Returns the event title or null.
   */
  async setEventDone(title: string, near: Date, time: string, done: boolean, days: number): Promise<string | null> {
    try {
      const p = await Cal.getCalendarPermissions();
      if (!p.granted) return null;
      const cals = (await Cal.getCalendars(Cal.EntityTypes.EVENT)).filter((c) => c.allowsModifications);
      const base = new Date(near.getFullYear(), near.getMonth(), near.getDate());
      const from = new Date(base.getTime() - days * 86_400_000);
      const to = new Date(base.getTime() + (days + 1) * 86_400_000);
      const list = await Cal.listEvents(cals.map((c) => c.id), from, to);
      const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const marked = (x: string) => /^\s*✓/.test(x);
      const hits = list
        .filter((e) => !e.recurrenceRule && marked(e.title ?? "") !== done && sameTitle(e.title ?? "", title))
        .filter((e) => !time || e.allDay || hm(toDate(e.startDate)) === time)
        .sort((a, b) => Math.abs(toDate(a.startDate).getTime() - near.getTime()) - Math.abs(toDate(b.startDate).getTime() - near.getTime()));
      const hit = hits[0];
      if (!hit) return null;
      const clean = (hit.title ?? "").replace(/^\s*✓\s*/, "");
      // the same event in several calendars (the pen writes it in each chosen one): all of them
      for (const x of hits.filter((y) => toDate(y.startDate).getTime() === toDate(hit.startDate).getTime())) {
        const ev = await Cal.ExpoCalendarEvent.get(x.id);
        await ev.update({ title: done ? `✓ ${clean}` : clean });
      }
      this.dropEvents();
      return clean;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- calendar

  async initCalendar(ask: boolean): Promise<void> {
    try {
      let p = await Cal.getCalendarPermissions();
      if (!p.granted && ask) p = await Cal.requestCalendarPermissions();
      if (!p.granted) {
        this.set({ calendarAccess: p.canAskAgain === false || ask ? "denied" : "unknown" });
        return;
      }
      const cals = await Cal.getCalendars(Cal.EntityTypes.EVENT);
      this.set({
        calendarAccess: "granted",
        calendars: cals.map((c) => ({ id: c.id, title: c.title, color: c.color ?? "#0A63D6", writable: !!c.allowsModifications })),
      });
    } catch (e) {
      this.set({ error: `Calendario: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /**
   * The events between two instants, straight from the iPhone calendars (for widgets, alerts, Live Activities: also
   * with the app in the background). The same event in several calendars comes once.
   */
  async eventsBetween(from: Date, to: Date): Promise<CalEvent[]> {
    try {
      const p = await Cal.getCalendarPermissions();
      if (!p.granted) return [];
      const cals = await Cal.getCalendars(Cal.EntityTypes.EVENT);
      const colors = new Map(cals.map((c) => [c.id, c.color ?? "#0A63D6"]));
      const list = await Cal.listEvents(cals.map((c) => c.id), from, to);
      const seen = new Set<string>();
      const out: CalEvent[] = [];
      for (const e of list) {
        const ev: CalEvent = {
          id: e.id,
          calendarId: e.calendarId,
          title: e.title || "(senza titolo)",
          start: toDate(e.startDate),
          end: toDate(e.endDate),
          allDay: !!e.allDay,
          color: colors.get(e.calendarId) ?? "#0A63D6",
          location: e.location ?? null,
          recurring: !!e.recurrenceRule,
        };
        const k = `${ev.title.replace(/^\s*✓\s*/, "").trim().toLowerCase()}|${ev.start.getTime()}|${ev.end.getTime()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(ev);
      }
      return out.sort((a, b) => a.start.getTime() - b.start.getTime());
    } catch {
      return [];
    }
  }

  /** Makes sure the events from `from` to `to` (days) are loaded. */
  async loadEvents(from: Date, to: Date): Promise<void> {
    if (this.snap.calendarAccess !== "granted" || !this.snap.calendars.length) return;
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime();
    if (this.loadedRanges.some(([x, y]) => x <= a && y >= b)) return;
    const epoch = this.snap.eventsEpoch;
    try {
      const list = await Cal.listEvents(this.snap.calendars.map((c) => c.id), new Date(a), new Date(b));
      // thrown away while loading (an event changed): the screen asks again with the new epoch
      if (epoch !== this.snap.eventsEpoch) return;
      const colors = new Map(this.snap.calendars.map((c) => [c.id, c.color]));
      const events = { ...this.snap.events };
      // day by day with the calendar (not +24 h: the day the clocks change has 23 or 25 hours)
      for (const d = new Date(a); d.getTime() < b; d.setDate(d.getDate() + 1)) events[ymd(d)] = [];
      for (const e of list) {
        const ev: CalEvent = {
          id: e.id,
          calendarId: e.calendarId,
          title: e.title || "(senza titolo)",
          start: toDate(e.startDate),
          end: toDate(e.endDate),
          allDay: !!e.allDay,
          color: colors.get(e.calendarId) ?? "#0A63D6",
          location: e.location ?? null,
          recurring: !!e.recurrenceRule,
        };
        // an event spanning several days appears on each of them
        const first = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
        for (let d = new Date(first); d < ev.end || ymd(d) === ymd(ev.start); d.setDate(d.getDate() + 1)) {
          const k = ymd(d);
          if (k in events) events[k] = [...events[k], ev];
          if (ev.allDay && d.getTime() + 86400000 >= ev.end.getTime()) break;
        }
      }
      for (const k of Object.keys(events)) events[k].sort((x, y) => Number(y.allDay) - Number(x.allDay) || x.start.getTime() - y.start.getTime());
      this.loadedRanges.push([a, b]);
      this.set({ events });
    } catch (e) {
      this.set({ error: `Calendario: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ---------------------------------------------------------------- the author's #tags (like the plugin's knownTags)

  private tags: string[] = [];
  private templatesFolder = "";

  /** The tags of the plugin's rules and the names of the templates (#cinema → Templates/Cinema.md). */
  knownTags(): string[] {
    const fromTemplates = this.templatesFolder
      ? [...this.files.keys()].filter((p) => p.startsWith(this.templatesFolder + "/") && p.endsWith(".md")).map((p) => p.slice(this.templatesFolder.length + 1, -3))
      : [];
    const name = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
    return [...new Set([...this.tags, ...fromTemplates.map(name)].filter(Boolean))];
  }

  private async readTags(): Promise<void> {
    try {
      const plugin = JSON.parse((await NeoPenBle.readVaultFile(".obsidian/plugins/neo-pen/data.json")) ?? "{}");
      this.tags = (Array.isArray(plugin.rules) ? plugin.rules : []).flatMap((r: { tags?: string[] }) => (Array.isArray(r.tags) ? r.tags : [])).map((t: string) => String(t).toLowerCase());
      const tp = JSON.parse((await NeoPenBle.readVaultFile(".obsidian/plugins/templater-obsidian/data.json")) ?? "{}");
      const core = JSON.parse((await NeoPenBle.readVaultFile(".obsidian/templates.json")) ?? "{}");
      this.templatesFolder = String(tp.templates_folder || core.folder || "").replace(/^\/+|\/+$/g, "");
    } catch {
      /* keeps what it had */
    }
  }

  // ---------------------------------------------------------------- the calendar follows the notes

  /** Where the app writes what it did by itself (the app's log). */
  log: (m: string) => void = () => undefined;
  /** The calendars chosen for what is written with the pen (none = the default one). */
  penCalendars: () => string[] = () => [];
  private following: Promise<void> = Promise.resolve();

  /**
   * Like the Obsidian plugin did with Google Calendar: a task with a time written with the pen that disappears from the
   * notes (struck through on the paper) takes its calendar event away with it; one whose date or time changes (the new
   * one written beside the struck one) moves its event. Only the events the pen created ("Scritto con la penna").
   */
  private followPen(): void {
    this.following = this.following.then(() => this.followPenNow()).catch(() => undefined);
  }

  private async followPenNow(): Promise<void> {
    const files = [...this.files.entries()].filter(([p]) => p !== APP_FILE).map(([path, f]) => ({ path, text: f.text }));
    if (!files.length) return;
    const now = penTimedTasks(files, this.all);
    const prev = readJson<{ list: PenTimed[] | null }>(FOLLOW_FILE, { list: null }).list;
    // the first reading only sets the starting point (nothing already in the notes is created again)
    const changes = prev ? diffPenTimed(prev, now, 6, ymd(new Date())) : [];
    if (changes.length) {
      const p = await Cal.getCalendarPermissions();
      // without the calendar: tried again later (the old reading is kept)
      if (!p.granted) return;
      for (const c of changes) await this.followChange(c, now);
      this.dropEvents();
    }
    writeJson(FOLLOW_FILE, { list: now });
  }

  private async followChange(c: FollowChange, now: PenTimed[]): Promise<void> {
    const at = (date: string, time: string) => {
      const [y, m, d] = date.split("-").map(Number);
      const [h, mi] = time.split(":").map(Number);
      return new Date(y, m - 1, d, h, mi);
    };
    const when = (d: Date) => d.toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    if (c.kind === "create") {
      // a new appointment in the notes → event (not twice: penEvent skips one already there, in any calendar)
      const start = at(c.date, c.time);
      const endAt = c.end ? at(c.date, c.end) : null;
      const note = c.file.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const r = await this.penEvent({ title: c.title, start, end: endAt, note: `Scritto con la penna (nota «${note}»).` }, this.penCalendars());
      if (r === "created") this.log(`«${c.title}» ${when(start)} → calendario.`);
      else if (r !== "exists" && r !== "noAccess") this.log(`Evento «${c.title}» non creato: ${r}`);
      return;
    }
    const cals = (await Cal.getCalendars(Cal.EntityTypes.EVENT)).filter((x) => x.allowsModifications).map((x) => x.id);
    if (!cals.length) return;
    const clean = (t: string | undefined) => (t ?? "").replace(/^\s*✓\s*/, "");
    const penEvents = async (start: Date, title: string) => {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const list = await Cal.listEvents(cals, day, new Date(day.getTime() + 86_400_000));
      const atTime = list.filter((e) => /^Scritto con la penna/.test(e.notes ?? "") && !e.allDay && toDate(e.startDate).getTime() === start.getTime());
      const same = atTime.filter((e) => sameTitle(clean(e.title), title));
      if (same.length) return same;
      // Claude may have read the title a bit differently on the two passes ("prova n° 2" / "trovare n° 2"): the only
      // pen event at that minute is it, if no task still in the notes at that minute is that event
      const titles = [...new Set(atTime.map((e) => looseTitle(clean(e.title))))];
      const day0 = ymd(start);
      const hm = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      const stillThere = now.filter((t) => t.date === day0 && t.time === hm);
      if (titles.length === 1 && !stillThere.some((t) => sameTitle(t.title, titles[0]))) return atTime;
      return [];
    };
    const from = at(c.date, c.time);
    const hits = await penEvents(from, c.title);
    if (!hits.length) return;
    if (c.kind === "delete") {
      for (const h of hits) await (await Cal.ExpoCalendarEvent.get(h.id)).delete();
      this.log(`«${c.title}» ${when(from)}: cancellata sulla carta → tolta anche dal calendario.`);
      return;
    }
    const start = at(c.to.date, c.to.time);
    const length = Math.max(15 * 60000, toDate(hits[0].endDate).getTime() - toDate(hits[0].startDate).getTime());
    const endAt = c.to.end ? at(c.to.date, c.to.end) : null;
    const end = endAt && endAt > start ? endAt : new Date(start.getTime() + length);
    // the phone may have already put the new time in the calendar (it reads the new writing too): the old one goes
    const already = await penEvents(start, c.to.title);
    for (const h of hits) {
      const ev = await Cal.ExpoCalendarEvent.get(h.id);
      if (already.some((a) => a.calendarId === h.calendarId)) await ev.delete();
      else await ev.update({ startDate: start, endDate: end });
    }
    this.log(`«${c.title}»: ${when(from)} → ${when(start)} (cambiato sulla carta, anche nel calendario).`);
  }

  /** The phone changed the vault or the calendar by itself (pen): lists read again if the app is showing them. */
  changedOutside(): void {
    if (!this.started) return;
    void this.refresh();
    this.dropEvents();
  }

  private dropEvents(): void {
    this.loadedRanges = [];
    this.set({ events: {}, eventsEpoch: this.snap.eventsEpoch + 1 });
  }

  async addEvent(q: QuickAdd, calendarId: string | null): Promise<boolean> {
    if (!q.date) return false;
    try {
      const cal = calendarId ? await Cal.ExpoCalendar.get(calendarId) : Cal.getDefaultCalendarSync();
      const [y, m, d] = q.date.split("-").map(Number);
      const allDay = !q.time;
      const start = q.time ? new Date(y, m - 1, d, ...(q.time.split(":").map(Number) as [number, number])) : new Date(y, m - 1, d);
      let end = q.end ? new Date(y, m - 1, d, ...(q.end.split(":").map(Number) as [number, number])) : null;
      if (!end || end <= start) end = allDay ? new Date(y, m - 1, d + 1) : new Date(start.getTime() + 60 * 60000);
      const title = [q.title, ...q.labels.map((l) => `#${l}`)].join(" ");
      await cal.createEvent({ title, startDate: start, endDate: end, allDay });
      this.dropEvents();
      return true;
    } catch (e) {
      this.set({ error: `Evento non creato: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  }

  async deleteEvent(ev: CalEvent): Promise<void> {
    try {
      const e = await Cal.ExpoCalendarEvent.get(ev.id);
      await e.delete();
      this.dropEvents();
    } catch (e) {
      this.set({ error: `Evento non cancellato: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async moveEvent(ev: CalEvent, start: Date, end: Date): Promise<void> {
    try {
      const e = await Cal.ExpoCalendarEvent.get(ev.id);
      await e.update({ startDate: start, endDate: end });
      this.dropEvents();
    } catch (e) {
      this.set({ error: `Evento non spostato: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  clearError = () => this.set({ error: null });
}

export const agenda = new Agenda();

/**
 * Events of a day without the doubles of timed tasks shown as tasks (a timed task written in Obsidian that also has an
 * event). The appointments written with the pen are not among the tasks: they show as events.
 */
export function visibleEvents(a: AgendaSnapshot, day: string): CalEvent[] {
  // the same event in several calendars (e.g. written by the pen in each chosen one): shown once
  const seen = new Set<string>();
  const evs = (a.events[day] ?? []).filter((e) => {
    const k = `${e.title.replace(/^\s*✓\s*/, "").trim().toLowerCase()}|${e.start.getTime()}|${e.end.getTime()}|${e.allDay}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const timed = a.tasks.filter((t) => t.date === day && t.time);
  if (!timed.length) return evs;
  return evs.filter((e) => {
    if (e.allDay) return true;
    const hm = `${String(e.start.getHours()).padStart(2, "0")}:${String(e.start.getMinutes()).padStart(2, "0")}`;
    return !timed.some((t) => sameTitle(t.title, e.title) && Math.abs(minutes(t.time!) - minutes(hm)) <= 90);
  });
}

const minutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
