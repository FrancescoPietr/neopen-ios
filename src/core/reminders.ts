// Which alerts to give and when (pure: tested in Node). The app schedules them with iOS (app/reminders.ts).
// - events: some minutes before (default: 15), or your own times for that event;
// - tasks with a time: at the time (default), or your own "⏰" times on the task;
// - tasks of the day without a time: one summary in the morning (default 9:00);
// - tasks with "⏰ …": exactly then.
import { VaultTask } from "./tasks";

export interface ReminderSettings {
  on: boolean;
  /** "Time sensitive": they also come through Focus / Do Not Disturb. */
  important: boolean;
  /** Minutes before an event (0 = at the time). Empty = no alerts for events. */
  eventOffsets: number[];
  /** Minutes before a task with a time. */
  taskOffsets: number[];
  /** "HH:MM" for the summary of the day's tasks without a time, or "" for none. */
  dayAt: string;
}

export const DEFAULT_REMINDERS: ReminderSettings = { on: true, important: true, eventOffsets: [15], taskOffsets: [0], dayAt: "09:00" };

export interface ReminderEvent {
  /** Stable key of the event (id + start). */
  key: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
}

export interface PlannedAlert {
  /** Changes when what it says or when it rings changes (so it is scheduled again). */
  id: string;
  at: number;
  title: string;
  body: string;
  kind: "event" | "task" | "day";
  /** What it is about: event key, task id, or the day. */
  ref: string;
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (day: string, time: string) => {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};

export function before(min: number): string {
  if (min <= 0) return "adesso";
  if (min < 60) return `tra ${min} min`;
  if (min < 1440) return min % 60 ? `tra ${Math.floor(min / 60)} h ${min % 60} min` : `tra ${min / 60} ${min === 60 ? "ora" : "ore"}`;
  return min === 1440 ? "domani" : `tra ${Math.round(min / 1440)} giorni`;
}

/** A short stable hash (for the ids). */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * The alerts from now to `now + horizon`, sorted, at most `limit` (iOS keeps 64 at a time).
 * `eventAlerts`: your own minutes-before for an event (by key), instead of the default ones.
 */
export function planAlerts(
  tasks: VaultTask[],
  events: ReminderEvent[],
  s: ReminderSettings,
  eventAlerts: Record<string, number[]>,
  now: number,
  horizonDays = 8,
  limit = 60
): PlannedAlert[] {
  if (!s.on) return [];
  const end = now + horizonDays * 86_400_000;
  const out: PlannedAlert[] = [];
  const push = (a: Omit<PlannedAlert, "id">) => {
    if (a.at <= now || a.at > end) return;
    out.push({ ...a, id: `np-${hash(`${a.kind}|${a.ref}|${a.at}|${a.title}|${a.body}`)}` });
  };

  for (const e of events) {
    const offsets = eventAlerts[e.key] ?? (e.allDay ? [] : s.eventOffsets);
    const start = new Date(e.start);
    const when = e.allDay ? "tutto il giorno" : `${hm(start)}–${hm(new Date(e.end))}`;
    for (const m of offsets) push({ at: e.start - m * 60_000, title: e.title.replace(/^\s*✓\s*/, ""), body: `${before(m)} · ${when}`, kind: "event", ref: e.key });
  }

  const open = tasks.filter((t) => !t.done);
  for (const t of open) {
    if (t.reminders.length) {
      for (const r of t.reminders) push({ at: at(r.slice(0, 10), r.slice(11, 16)), title: t.title, body: t.time ? `alle ${t.time}` : "da fare", kind: "task", ref: t.id });
      continue;
    }
    if (t.time && t.date) for (const m of s.taskOffsets) push({ at: at(t.date, t.time) - m * 60_000, title: t.title, body: `${before(m)} · ${t.time}`, kind: "task", ref: t.id });
  }

  // one summary a day of the tasks without a time (their own alerts aside)
  if (/^\d{1,2}:\d{2}$/.test(s.dayAt)) {
    for (let d = new Date(now); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
      const day = ymdOf(d);
      const list = open.filter((t) => t.date === day && !t.time && !t.reminders.length);
      if (!list.length) continue;
      const names = list.slice(0, 4).map((t) => t.title);
      push({
        at: at(day, s.dayAt.padStart(5, "0")),
        title: list.length === 1 ? "Oggi hai 1 attività" : `Oggi hai ${list.length} attività`,
        body: names.join(", ") + (list.length > 4 ? `, e altre ${list.length - 4}` : ""),
        kind: "day",
        ref: day,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}
