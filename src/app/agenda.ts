// The agenda: tasks from the Obsidian vault (markdown) + events from the iPhone calendars (EventKit, like Fantastical).
// Everything else in the app reads it through useAgenda().
import * as Cal from "expo-calendar";
import { AppState } from "react-native";
import NeoPenBle from "../../modules/neopen-ble";
import { QuickAdd } from "../core/quickadd";
import { DailyConfig, TaskEdit, appendTask, buildIndex, deleteTask, editTask, projectFile, toggleTask } from "../core/taskStore";
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
  tasks: VaultTask[];
  loading: boolean;
  error: string | null;
  calendarAccess: "unknown" | "granted" | "denied";
  calendars: CalInfo[];
  /** Events by day (YYYY-MM-DD) for the days loaded so far. */
  events: Record<string, CalEvent[]>;
  /** Changes at every refresh (for lists). */
  version: number;
}

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

class Agenda {
  private snap: AgendaSnapshot = { vaultName: null, tasks: [], loading: false, error: null, calendarAccess: "unknown", calendars: [], events: {}, version: 0 };
  private listeners = new Set<() => void>();
  private files = new Map<string, { mtime: number; text: string }>();
  private daily: DailyConfig = { folder: "Daily", format: "YYYY-MM-DD" };
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
        this.loadedRanges = [];
        this.set({ events: {} });
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
    if (!vaultName) {
      this.set({ vaultName: null, tasks: [] });
      return;
    }
    this.set({ loading: true, vaultName });
    try {
      const cfg = await NeoPenBle.readVaultFile(".obsidian/daily-notes.json");
      if (cfg) {
        try {
          const j = JSON.parse(cfg);
          this.daily = { folder: String(j.folder ?? ""), format: String(j.format || "YYYY-MM-DD") };
        } catch {
          /* default */
        }
      }
      const list = await NeoPenBle.listVaultMarkdown();
      const seen = new Set<string>();
      for (const f of list) {
        seen.add(f.path);
        const cur = this.files.get(f.path);
        if (cur && cur.mtime === f.mtime) continue;
        const text = await NeoPenBle.readVaultFile(f.path);
        if (text !== null) this.files.set(f.path, { mtime: f.mtime, text });
      }
      for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);
      this.rebuild(null);
    } catch (e) {
      this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private rebuild(error: string | null): void {
    const tasks = buildIndex(
      [...this.files.entries()].map(([path, f]) => ({ path, text: f.text })),
      this.daily
    );
    this.set({ tasks, loading: false, error });
  }

  /** Applies an edit to a file and writes it into the vault. */
  private async change(path: string, edit: (text: string | null) => string | null): Promise<boolean> {
    const fresh = await NeoPenBle.readVaultFile(path);
    const next = edit(fresh);
    if (next === null) {
      // the file changed (e.g. in Obsidian): read everything again and let the user retry
      await this.refresh();
      this.set({ error: "La nota è cambiata nel frattempo: riprova." });
      return false;
    }
    const err = NeoPenBle.writeVaultFile(path, next);
    if (err) {
      this.set({ error: `Non riesco a scrivere «${path}»: ${err}` });
      return false;
    }
    this.files.set(path, { mtime: Date.now(), text: next });
    this.rebuild(null);
    return true;
  }

  toggle = (t: VaultTask) => this.change(t.file, (text) => (text === null ? null : toggleTask(text, t, ymd(new Date()))));
  edit = (t: VaultTask, e: TaskEdit) => this.change(t.file, (text) => (text === null ? null : editTask(text, t, e)));
  remove = (t: VaultTask) => this.change(t.file, (text) => (text === null ? null : deleteTask(text, t, this.snap.tasks)));

  /** New task in a project file (Inbox if none). */
  addTask = (q: QuickAdd, project?: string | null) => {
    const name = project || q.project || "Inbox";
    return this.change(projectFile(name), (text) => appendTask(text, q, name));
  };

  /** Moves a task to another project: added there, removed here. */
  async move(t: VaultTask, project: string): Promise<void> {
    const q: QuickAdd = { title: t.text, date: t.dateFromNote ? t.date : t.date, time: t.time, end: t.end, recurrence: t.recurrence, priority: t.priority, labels: [], project, matched: [] };
    if (await this.change(projectFile(project), (text) => appendTask(text, q, project))) await this.remove(t);
  }

  obsidianLink(path: string): string {
    const vault = this.snap.vaultName ?? "";
    return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
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

  /** Makes sure the events from `from` to `to` (days) are loaded. */
  async loadEvents(from: Date, to: Date): Promise<void> {
    if (this.snap.calendarAccess !== "granted" || !this.snap.calendars.length) return;
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime();
    if (this.loadedRanges.some(([x, y]) => x <= a && y >= b)) return;
    try {
      const list = await Cal.listEvents(this.snap.calendars.map((c) => c.id), new Date(a), new Date(b));
      const colors = new Map(this.snap.calendars.map((c) => [c.id, c.color]));
      const events = { ...this.snap.events };
      for (let d = a; d < b; d += 86400000) events[ymd(new Date(d))] = [];
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

  private dropEvents(): void {
    this.loadedRanges = [];
    this.set({ events: {} });
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
