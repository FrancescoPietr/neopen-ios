// What the lock-screen card shows: the appointments of the next 24 hours, nearest first (with a countdown in the card),
// and the tasks of today still to do — a task disappears from the card as soon as it is done.
import { VaultTask, ymd } from "./tasks";

export interface LockEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export const sameEvent = (e: LockEvent) => `${e.title.replace(/^\s*✓\s*/, "").trim().toLowerCase()}|${e.start.getTime()}|${e.end.getTime()}|${e.allDay}`;

/** The same event in several calendars (e.g. written by the pen in each chosen one): kept once. */
export function uniqueEvents<E extends LockEvent>(events: E[]): E[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = sameEvent(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The appointments of the next 24 hours not over yet (all-day ones have no countdown: left out), nearest first. */
export function comingEvents(events: LockEvent[], now = Date.now()) {
  const today = ymd(new Date(now));
  return uniqueEvents(events)
    .filter((e) => !e.allDay && !/^\s*✓/.test(e.title) && e.end.getTime() > now && e.start.getTime() < now + 24 * 3_600_000)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((e) => ({
      title: e.title,
      time: ymd(e.start) === today ? hm(e.start) : `domani ${hm(e.start)}`,
      done: false,
      start: e.start.getTime(),
      end: e.end.getTime(),
      color: e.color,
    }));
}

/** The tasks of today (and late ones) for the lock screen: only those still to do. */
export function todayTasks(tasks: VaultTask[], now = new Date()) {
  const today = ymd(now);
  const todays = tasks.filter((t) => t.date && (t.date === today || (!t.done && t.date < today)));
  const open = todays.filter((t) => !t.done).sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99"));
  return { open, done: todays.length - open.length, total: todays.length };
}

