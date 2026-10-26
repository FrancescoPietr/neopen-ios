// Everything the app shows outside itself, kept up to date together: the widgets (widget.json in the App Group),
// the alerts, and the Live Activities (countdown to the next appointment, tasks of today).
// Called when the agenda changes, when the app comes back on screen, after the pen wrote something, when settings or
// the look change. Ticks made on the widget (toggles.json) are applied to the vault first.
import { AppState } from "react-native";
import NeoPenBle from "../../modules/neopen-ble";
import { ReminderEvent } from "../core/reminders";
import { VaultTask, ymd } from "../core/tasks";
import { drawings } from "../ui/theme/drawings";
import { T, theme } from "../ui/theme/theme";
import { CalEvent, agenda } from "./agenda";
import { alerts, eventKey } from "./alerts";

const taskKey = (t: VaultTask) => `${t.file}|${t.title}|${t.date ?? ""}|${t.time ?? ""}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();
const live: { event?: { id: string; ref: string }; tasks?: { id: string } } = {};

function look() {
  const pick = (id: string) => drawings.get(id)?.strokes;
  return {
    paper: T.paper,
    ink: T.ink,
    soft: T.inkSoft,
    faint: T.faint,
    line: T.line,
    accent: T.accent,
    red: T.red,
    hand: T.hand,
    profile: drawings.get("rule")?.profile ?? null,
    drawings: Object.fromEntries(["check.empty", "check.done", "today", "dot"].map((id) => [id, pick(id)]).filter(([, v]) => v)),
  };
}

/** Ticks made on the widget, applied to the vault. */
async function applyWidgetToggles(tasks: VaultTask[]): Promise<boolean> {
  let list: { key: string; done: string }[] = [];
  try {
    list = JSON.parse(NeoPenBle.readShared("toggles.json") ?? "[]");
  } catch {
    list = [];
  }
  if (!list.length) return false;
  NeoPenBle.writeShared("toggles.json", "[]");
  let changed = false;
  // the last tick of each task wins
  const last = new Map(list.map((x) => [x.key, x.done === "1"]));
  for (const [key, done] of last) {
    const t = tasks.find((x) => taskKey(x) === key);
    if (t && t.done !== done) {
      await agenda.toggle(t);
      changed = true;
    }
  }
  return changed;
}

function writeWidgets(tasks: VaultTask[], events: CalEvent[]): void {
  const today = ymd(new Date());
  const horizon = ymd(new Date(Date.now() + 15 * 86_400_000));
  const monthStart = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const wanted = tasks.filter(
    (t) => (!t.done && (!t.date || t.date <= horizon)) || (t.done && t.doneDate === today) || (t.date && t.date >= monthStart && t.date <= horizon)
  );
  const data = {
    updated: Date.now(),
    look: look(),
    events: events.map((e) => ({
      key: eventKey(e),
      title: e.title.replace(/^\s*✓\s*/, ""),
      start: e.start.getTime(),
      end: e.end.getTime(),
      allDay: e.allDay,
      color: e.color,
      done: /^\s*✓/.test(e.title),
    })),
    tasks: wanted.slice(0, 200).map((t) => ({ key: taskKey(t), title: t.title, date: t.date, time: t.time, done: t.done, priority: t.priority })),
  };
  NeoPenBle.writeShared("widget.json", JSON.stringify(data));
  NeoPenBle.reloadWidgets();
}

function baseState() {
  return { paper: T.paper, ink: T.ink, soft: T.inkSoft, accent: T.accent, hand: T.hand };
}

/** The next appointment (event or task with a time) within 8 hours, or null. */
function nextAppointment(tasks: VaultTask[], events: CalEvent[]) {
  const now = Date.now();
  const soon = now + 8 * 3_600_000;
  const list: { ref: string; title: string; start: number; end: number; color: string; subtitle: string }[] = [];
  for (const e of events) {
    if (e.allDay || /^\s*✓/.test(e.title) || e.end.getTime() <= now || e.start.getTime() > soon) continue;
    list.push({ ref: eventKey(e), title: e.title, start: e.start.getTime(), end: e.end.getTime(), color: e.color, subtitle: `${hm(e.start)}–${hm(e.end)}${e.location ? ` · ${e.location}` : ""}` });
  }
  for (const t of tasks) {
    if (t.done || !t.time || !t.date) continue;
    const [y, m, d] = t.date.split("-").map(Number);
    const [h, mi] = t.time.split(":").map(Number);
    const start = new Date(y, m - 1, d, h, mi).getTime();
    const [eh, emi] = (t.end ?? "").split(":").map(Number);
    const end = t.end ? new Date(y, m - 1, d, eh, emi).getTime() : start + 30 * 60_000;
    if (end <= now || start > soon) continue;
    list.push({ ref: taskKey(t), title: t.title, start, end, color: T.accent, subtitle: t.end ? `${t.time}–${t.end}` : `alle ${t.time}` });
  }
  return list.sort((a, b) => a.start - b.start)[0] ?? null;
}

async function updateLive(tasks: VaultTask[], events: CalEvent[], onScreen: boolean): Promise<void> {
  if (!NeoPenBle.liveEnabled()) return;
  const s = alerts.get();
  const existing = NeoPenBle.liveList();
  // ---- countdown
  const next = s.countdown ? nextAppointment(tasks, events) : null;
  const ev = existing.find((x) => x.kind === "event");
  if (!next) {
    if (ev) await NeoPenBle.liveEnd(ev.id, 0);
    live.event = undefined;
  } else {
    const state = { kind: "event", title: next.title, subtitle: next.subtitle, start: next.start, end: next.end, color: next.color, items: [], more: 0, done: 0, total: 0, ...baseState() };
    const json = JSON.stringify(state);
    if (ev && live.event?.ref === next.ref) await NeoPenBle.liveUpdate(ev.id, json, next.start);
    else if (ev && !onScreen) await NeoPenBle.liveUpdate(ev.id, json, next.start);
    else if (onScreen) {
      if (ev) await NeoPenBle.liveEnd(ev.id, 0);
      const id = await NeoPenBle.liveStart("event", json, next.start);
      if (!id.startsWith("errore")) live.event = { id, ref: next.ref };
    }
  }
  // ---- tasks of today
  const tk = existing.find((x) => x.kind === "tasks");
  if (!s.todayCard) {
    if (tk) await NeoPenBle.liveEnd(tk.id, 0);
    return;
  }
  const today = ymd(new Date());
  const todays = tasks.filter((t) => t.date && (t.date === today || (!t.done && t.date < today)));
  const open = todays.filter((t) => !t.done).sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99"));
  const done = todays.filter((t) => t.done);
  const shown = [...open, ...done].slice(0, 5);
  const state = {
    kind: "tasks",
    title: "Oggi",
    subtitle: open.length ? `${done.length} di ${todays.length} fatte` : todays.length ? "tutto fatto" : "niente da fare",
    start: Date.now(),
    end: Date.now(),
    color: T.accent,
    items: shown.map((t) => ({ title: t.title, time: t.time ?? "", done: t.done })),
    more: Math.max(0, todays.length - shown.length),
    done: done.length,
    total: todays.length,
    ...baseState(),
  };
  const json = JSON.stringify(state);
  if (tk) await NeoPenBle.liveUpdate(tk.id, json, 0);
  else if (onScreen && todays.length) {
    const id = await NeoPenBle.liveStart("tasks", json, 0);
    if (!id.startsWith("errore")) live.tasks = { id };
  }
}

async function run(onScreen: boolean): Promise<void> {
  let tasks = await agenda.freshTasks();
  if (await applyWidgetToggles(tasks)) tasks = await agenda.freshTasks();
  const from = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = new Date(Math.max(new Date(from.getFullYear(), from.getMonth() + 1, 1).getTime(), Date.now() + 9 * 86_400_000));
  const events = await agenda.eventsBetween(new Date(Math.min(from.getTime(), Date.now() - 86_400_000)), to);
  try {
    writeWidgets(tasks, events);
  } catch {
    /* widgets: next time */
  }
  const remEvents: ReminderEvent[] = events.map((e) => ({ key: eventKey(e), title: e.title, start: e.start.getTime(), end: e.end.getTime(), allDay: e.allDay }));
  await alerts.schedule(tasks, remEvents);
  try {
    await updateLive(tasks, events, onScreen);
  } catch {
    /* Live Activities: next time */
  }
}

/** Updates widgets, alerts and Live Activities (soon: changes close together are done once). */
export function refreshOutputs(delay = 1200): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const onScreen = AppState.currentState === "active";
    const task = NeoPenBle.beginBackgroundTask("widget-avvisi");
    running = running
      .then(() => run(onScreen))
      .catch(() => undefined)
      .finally(() => NeoPenBle.endBackgroundTask(task));
  }, delay);
}

/** Started once: follows the agenda, the look, the settings, and the app coming back on screen. */
export function startOutputs(): void {
  // only real changes (the agenda also changes while it loads, and when this file reads it)
  let seen = "";
  agenda.subscribe(() => {
    const a = agenda.getSnapshot();
    const sig = `${a.eventsEpoch}#${a.tasks.length}#${a.tasks.map((t) => `${t.id}${t.done ? 1 : 0}${t.date}${t.time}${t.title}${t.reminders.join()}`).join("|")}`;
    if (sig === seen) return;
    seen = sig;
    refreshOutputs(2500);
  });
  theme.subscribe(() => refreshOutputs(800));
  alerts.subscribe(() => refreshOutputs(300));
  AppState.addEventListener("change", (s) => {
    if (s === "active") {
      void alerts.ensurePermission(alerts.get().on);
      refreshOutputs(400);
    }
  });
  if (AppState.currentState === "active") void alerts.ensurePermission(alerts.get().on);
  refreshOutputs(1500);
}
