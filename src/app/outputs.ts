// Everything the app shows outside itself, kept up to date together: the widgets (widget.json in the App Group),
// the alerts, and the Live Activity on the lock screen (coming appointments with a countdown, tasks of today).
// Called when the agenda changes, when the app comes back on screen, after the pen wrote something, when settings or
// the look change. Ticks made on the widget (toggles.json) are applied to the vault first.
import { AppState } from "react-native";
import NeoPenBle from "../../modules/neopen-ble";
import { ReminderEvent } from "../core/reminders";
import { comingEvents, todayTasks, uniqueEvents } from "../core/lockCard";
import { VaultTask, ymd } from "../core/tasks";
import { drawings } from "../ui/theme/drawings";
import { T, theme } from "../ui/theme/theme";
import { CalEvent, agenda } from "./agenda";
import { alerts, eventKey } from "./alerts";

const taskKey = (t: VaultTask) => `${t.file}|${t.title}|${t.date ?? ""}|${t.time ?? ""}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();

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
    drawings: Object.fromEntries(["check.empty", "check.done", "today", "dot", "nav.prev", "nav.next", "log", "tab.calendar"].map((id) => [id, pick(id)]).filter(([, v]) => v)),
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
    events: uniqueEvents(events).map((e) => ({
      key: eventKey(e),
      title: e.title.replace(/^\s*✓\s*/, ""),
      start: e.start.getTime(),
      end: e.end.getTime(),
      allDay: e.allDay,
      color: e.color,
      done: /^\s*✓/.test(e.title),
    })),
    // days with something to do, for the dots of the month (also months away)
    taskDays: [...new Set(tasks.filter((t) => !t.done && t.date).map((t) => t.date as string))].sort(),
    tasks: wanted.slice(0, 200).map((t) => ({ key: taskKey(t), title: t.title, date: t.date, time: t.time, done: t.done, priority: t.priority })),
  };
  NeoPenBle.writeShared("widget.json", JSON.stringify(data));
  NeoPenBle.reloadWidgets();
}

function baseState() {
  return { paper: T.paper, ink: T.ink, soft: T.inkSoft, accent: T.accent, hand: T.hand };
}

async function updateLive(tasks: VaultTask[], events: CalEvent[], onScreen: boolean): Promise<void> {
  if (!NeoPenBle.liveEnabled()) return;
  const s = alerts.get();
  const existing = NeoPenBle.liveList();
  // the two separate ones of the previous version: replaced by the single card
  for (const a of existing) if (a.kind !== "today") await NeoPenBle.liveEnd(a.id, 0);
  const cur = existing.find((x) => x.kind === "today");

  const evs = s.countdown ? comingEvents(events).slice(0, 5) : [];
  const t = s.todayCard ? todayTasks(tasks) : { open: [], done: 0, total: 0 };
  if (!evs.length && !t.open.length) {
    if (cur) await NeoPenBle.liveEnd(cur.id, 0);
    return;
  }
  const subtitle = s.todayCard && t.total ? `${t.done} di ${t.total} fatte` : evs.length === 1 ? "1 impegno" : `${evs.length} impegni`;
  const now = Date.now();
  const state = {
    kind: "today",
    title: "Oggi",
    subtitle,
    start: now,
    end: now,
    color: T.accent,
    items: t.open.slice(0, 5).map((x) => ({ title: x.title, time: x.time ?? "", done: false })),
    events: evs,
    more: Math.max(0, t.open.length - 5),
    done: t.done,
    total: t.total,
    ...baseState(),
  };
  // when the next appointment starts or ends, iOS redraws the card
  const stale = evs.map((e) => (e.start > now ? e.start : e.end)).filter((x) => x > now).sort((a, b) => a - b)[0] ?? 0;
  const json = JSON.stringify(state);
  if (cur) await NeoPenBle.liveUpdate(cur.id, json, stale);
  else if (onScreen) await NeoPenBle.liveStart("today", json, stale);
}

async function run(onScreen: boolean): Promise<void> {
  let tasks = await agenda.freshTasks();
  if (await applyWidgetToggles(tasks)) tasks = await agenda.freshTasks();
  // the appointments written with the pen are events (in the calendar), not tasks: shown once, as events
  tasks = agenda.visible(tasks);
  // last month, this one and the next (the widget's month can be moved with the arrows)
  const n = new Date();
  const from = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  const to = new Date(Math.max(new Date(n.getFullYear(), n.getMonth() + 2, 1).getTime(), Date.now() + 9 * 86_400_000));
  const events = await agenda.eventsBetween(from, to);
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
