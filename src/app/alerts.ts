// Alerts (local notifications) and the switches of the lock screen: settings saved in avvisi.json, scheduling with
// iOS (at most 60 at a time: the nearest ones; scheduled again at every change).
import * as Notifications from "expo-notifications";
import { DEFAULT_REMINDERS, PlannedAlert, ReminderEvent, ReminderSettings, planAlerts } from "../core/reminders";
import { VaultTask } from "../core/tasks";
import { readJson, writeJson } from "./files";

export interface AlertSettings extends ReminderSettings {
  /** Countdown to the next appointment on the lock screen (Live Activity). */
  countdown: boolean;
  /** The tasks of today on the lock screen (Live Activity). */
  todayCard: boolean;
  /** Your own alerts for single events: minutes before, by event key (id|start). */
  eventAlerts: Record<string, number[]>;
}

const FILE = "avvisi.json";
const DEFAULTS: AlertSettings = { ...DEFAULT_REMINDERS, countdown: true, todayCard: true, eventAlerts: {} };

let settings: AlertSettings = { ...DEFAULTS, ...readJson<Partial<AlertSettings>>(FILE, {}) };
const listeners = new Set<() => void>();
let version = 0;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export const eventKey = (e: { id: string; start: Date }) => `${e.id}|${e.start.getTime()}`;

export const alerts = {
  get: (): AlertSettings => settings,
  version: () => version,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  set(patch: Partial<AlertSettings>): void {
    settings = { ...settings, ...patch };
    version++;
    writeJson(FILE, settings);
    for (const fn of listeners) fn();
  },
  /** Your own alerts for an event (null = the default ones). */
  setEventAlerts(key: string, offsets: number[] | null): void {
    const next = { ...settings.eventAlerts };
    if (offsets === null) delete next[key];
    else next[key] = offsets;
    // old events are forgotten
    const now = Date.now();
    for (const k of Object.keys(next)) if (Number(k.split("|").pop()) < now - 86_400_000) delete next[k];
    this.set({ eventAlerts: next });
  },

  /** Notification permission: asked only with the app on screen. */
  async ensurePermission(ask: boolean): Promise<boolean> {
    try {
      const p = await Notifications.getPermissionsAsync();
      if (p.granted) return true;
      if (!ask || !p.canAskAgain) return false;
      const r = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
      return r.granted;
    } catch {
      return false;
    }
  },

  /** Schedules the alerts of the coming days (only the changed ones are replaced). */
  async schedule(tasks: VaultTask[], events: ReminderEvent[]): Promise<PlannedAlert[]> {
    const plan = planAlerts(tasks, events, settings, settings.eventAlerts, Date.now());
    try {
      if (!(await this.ensurePermission(false))) return plan;
      const existing = await Notifications.getAllScheduledNotificationsAsync();
      const ours = existing.filter((n) => n.identifier.startsWith("np-"));
      const want = new Map(plan.map((a) => [a.id + (settings.important ? "i" : ""), a]));
      for (const n of ours) if (!want.has(n.identifier)) await Notifications.cancelScheduledNotificationAsync(n.identifier);
      const have = new Set(ours.map((n) => n.identifier));
      for (const [id, a] of want) {
        if (have.has(id)) continue;
        await Notifications.scheduleNotificationAsync({
          identifier: id,
          content: {
            title: a.title,
            body: a.body,
            sound: "default",
            interruptionLevel: settings.important ? "timeSensitive" : "active",
            data: { kind: a.kind, ref: a.ref, at: a.at },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: a.at },
        });
      }
    } catch {
      /* tried again at the next change */
    }
    return plan;
  },

  /** An alert right away (e.g. Claude's credit ran out), at most once every `minutes` for the same id. */
  async now(id: string, title: string, body: string, minutes = 60): Promise<void> {
    try {
      const last = readJson<Record<string, number>>("avvisi-subito.json", {});
      if (Date.now() - (last[id] ?? 0) < minutes * 60_000) return;
      if (!(await this.ensurePermission(false))) return;
      await Notifications.scheduleNotificationAsync({ content: { title, body, sound: "default" }, trigger: null });
      writeJson("avvisi-subito.json", { ...last, [id]: Date.now() });
    } catch {
      /* not important */
    }
  },

  /** A test alert in 5 seconds. */
  async test(): Promise<boolean> {
    if (!(await this.ensurePermission(true))) return false;
    await Notifications.scheduleNotificationAsync({
      content: { title: "Prova", body: "Così arrivano gli avvisi di NeoTransfer.", sound: "default", interruptionLevel: settings.important ? "timeSensitive" : "active" },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5 },
    });
    return true;
  },

  async cancelAll(): Promise<void> {
    try {
      const existing = await Notifications.getAllScheduledNotificationsAsync();
      for (const n of existing) if (n.identifier.startsWith("np-")) await Notifications.cancelScheduledNotificationAsync(n.identifier);
    } catch {
      /* nothing to do */
    }
  },
};
