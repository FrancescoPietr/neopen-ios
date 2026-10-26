// Task scritti a mano → Google Calendar e Google Tasks.
// Si guarda il contenuto delle note (solo i blocchi trascritti dalla penna) e si allinea Google:
//   - task con orario (o 14:00-14:30) → evento con orario
//   - task senza orario               → Google Tasks (con scadenza se c'è una data)
//     (con Google Tasks spento: task con sola data → evento di un giorno intero)
//   - task spuntato                    → evento con "✓" e grigio / attività completata
//   - task cancellato/tolto dalla nota → evento tolto dal calendario
// Funziona sia dopo la trascrizione sia quando modifichi la nota a mano (es. spunti in Obsidian).

import { App, TFile, moment as obsidianMoment } from "obsidian";
import { readBlock } from "../transcribe/noteBlock";
import { CalendarOp, callCalendar } from "./GoogleCalendar";
import { Todoist } from "./Todoist";

/** Dove finiscono i task senza orario. */
export type TasksTarget = "google" | "todoist" | "none";
export type EntryKind = "event" | "task" | "todoist";

const moment = obsidianMoment as unknown as (...args: any[]) => import("moment").Moment;

export interface PenTask {
  key: string;
  pageId: string;
  text: string;
  done: boolean;
  date: string | null;
  time: string | null;
  end: string | null;
  /** Risposte scritte con una freccia dal task (righe "↳" sotto il task). */
  notes?: string[];
}

export interface CalendarEntry {
  id: string;
  hash: string;
  date: string;
  /** Evento del calendario (predefinito), attività di Google Tasks o di Todoist. */
  kind?: EntryKind;
}

export interface CalendarSettings {
  calendarEnabled: boolean;
  calendarUrl: string;
  calendarSecret: string;
  calendarId: string;
  eventMinutes: number;
  calendarAllDay: boolean;
  calendarEverywhere: boolean;
  googleTasks: boolean;
  tasksList: string;
  tasksTarget: TasksTarget;
  todoistToken: string;
  todoistProject: string;
  eventTimezone: EventTimezone;
  calendarEvents: Record<string, CalendarEntry>;
}

const TASK_RE = /^\s*- \[([ xX])\] (?:(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))? )?(.*?)(?: 📅 (\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * Fuso orario degli eventi:
 *  - "device": quello di questo dispositivo (come il telefono: automatico) — predefinito
 *  - "calendar": quello impostato in Google Calendar
 *  - un nome IANA scelto a mano (es. "Europe/Rome")
 */
export type EventTimezone = "device" | "calendar" | string;

/** Minuti di differenza da UTC del fuso `tz` in quell'istante. */
function tzOffsetMinutes(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUtc - ts) / 60000);
}

/** Il nome del fuso è valido? */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD HH:mm" (ora scritta a mano) → istante ISO, nel fuso scelto. */
export function wallToIso(local: string, tz: EventTimezone): string {
  if (tz === "device" || tz === "calendar" || !tz || !validTimezone(tz)) return moment(local, "YYYY-MM-DD HH:mm").format();
  const [d, t] = local.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  const wall = Date.UTC(Y, M - 1, D, h, m);
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - tzOffsetMinutes(utc, tz) * 60000;
  return new Date(utc).toISOString();
}

/** Riferimento corto e stabile di un task (va nell'evento / nell'attività per ritrovarli). */
export function shortRef(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function norm(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Id delle pagine che hanno un blocco trascritto in questa nota. */
export function blockIds(content: string): string[] {
  return [...content.matchAll(/<!-- neopen:testo:(\d+_\d+_\d+_\d+(?:~\d+)?) -->/g)].map((m) => m[1]);
}

/** I task scritti a mano nei blocchi indicati. */
export function tasksInBlocks(content: string, ids: string[]): PenTask[] {
  const out: PenTask[] = [];
  const seen = new Map<string, number>();
  for (const id of ids) {
    for (const line of readBlock(content, id).split("\n")) {
      // risposta sotto il task (freccia): va nelle note dell'evento / attività, non è un task
      const r = /^\s+- ↳ (.*)$/.exec(line);
      if (r) {
        const last = out[out.length - 1];
        if (last && last.pageId === id && r[1].trim()) (last.notes ??= []).push(r[1].trim());
        continue;
      }
      const m = TASK_RE.exec(line);
      if (!m) continue;
      const text = m[4].trim();
      if (!text) continue;
      let key = `${id}|${norm(text)}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      if (n) key += `#${n + 1}`; // stesso task scritto due volte
      out.push({
        key,
        pageId: id,
        text,
        done: m[1] !== " ",
        date: m[5] ?? null,
        time: m[2] ? m[2].padStart(5, "0") : null,
        end: m[3] ? m[3].padStart(5, "0") : null,
      });
    }
  }
  return out;
}

/**
 * Operazioni per allineare il calendario ai task di una nota.
 * `scope`: le pagine di questa nota che vanno nel calendario (i loro eventi spariti vengono tolti).
 */
export function planCalendar(
  tasks: PenTask[],
  scope: string[],
  stored: Record<string, CalendarEntry>,
  opts: {
    minutes: number;
    allDay: boolean;
    target: TasksTarget;
    /** Fuso orario degli eventi (predefinito: quello del dispositivo). */
    tz?: EventTimezone;
    tasksList?: string;
    /** Giorno per i task con il solo orario (nota del giorno, o oggi). */
    fallbackDate: string;
    /** Scadenza delle attività senza data (giorno della nota del giorno), null = nessuna. */
    taskDate?: string | null;
    description: string;
  }
): { ops: PlannedOp[]; hashes: Record<string, { hash: string; date: string; kind: EntryKind }> } {
  const ops: PlannedOp[] = [];
  const hashes: Record<string, { hash: string; date: string; kind: EntryKind }> = {};
  const wanted = new Set<string>();
  const del = (key: string, e: CalendarEntry) =>
    ops.push({ action: "delete", kind: e.kind ?? "event", key: shortRef(key), id: e.id, date: e.date, list: opts.tasksList, fullKey: key });
  for (const t of tasks) {
    if (!scope.includes(t.pageId)) continue;
    const prev = stored[t.key];
    let op: PlannedOp;
    let date: string;
    if (t.time) {
      // evento con orario
      date = t.date ?? prev?.date ?? opts.fallbackDate;
      const start = moment(`${date} ${t.time}`, "YYYY-MM-DD HH:mm");
      let end = t.end ? moment(`${date} ${t.end}`, "YYYY-MM-DD HH:mm") : null;
      if (!end || !end.isAfter(start)) end = start.clone().add(Math.max(5, opts.minutes), "minutes");
      const tz = opts.tz ?? "device";
      const startLocal = start.format("YYYY-MM-DD HH:mm");
      const endLocal = end.format("YYYY-MM-DD HH:mm");
      op = {
        action: "upsert",
        kind: "event",
        allDay: false,
        date,
        start: wallToIso(startLocal, tz),
        end: wallToIso(endLocal, tz),
        // solo con "fuso del calendario" è lo script a decidere il fuso
        ...(tz === "calendar" ? { startLocal, endLocal } : {}),
      } as PlannedOp;
    } else if (opts.target !== "none") {
      // attività (Google Tasks o Todoist)
      date = t.date ?? opts.taskDate ?? "";
      op = { action: "upsert", kind: opts.target === "todoist" ? "todoist" : "task", date, list: opts.tasksList } as PlannedOp;
    } else if (t.date && opts.allDay) {
      date = t.date;
      op = { action: "upsert", kind: "event", allDay: true, date } as PlannedOp;
    } else {
      continue; // niente data né orario: resta solo nella nota
    }
    const description = t.notes?.length ? `${t.notes.join("\n")}\n\n${opts.description}` : opts.description;
    Object.assign(op, { key: shortRef(t.key), fullKey: t.key, title: t.text, description, done: t.done });
    const kind = op.kind as EntryKind;
    const hash = JSON.stringify([kind, op.title, op.description, op.allDay ?? false, date, op.start ?? "", op.end ?? "", t.done, op.list ?? "", op.startLocal ? "cal" : ""]);
    wanted.add(t.key);
    if (prev?.hash === hash) continue;
    if (prev && (prev.kind ?? "event") !== kind) del(t.key, prev); // da evento ad attività (o viceversa)
    else if (prev) op.id = prev.id;
    ops.push(op);
    hashes[t.key] = { hash, date, kind };
  }
  for (const [key, e] of Object.entries(stored)) {
    const pid = key.split("|")[0];
    if (scope.includes(pid) && !wanted.has(key)) del(key, e);
  }
  return { ops, hashes };
}

/** Operazione con la chiave completa del task (per aggiornare l'indice). */
export type PlannedOp = Omit<CalendarOp, "kind"> & { kind: EntryKind; fullKey: string };

export class CalendarSync {
  private timers = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private settings: () => CalendarSettings,
    private save: () => Promise<void>,
    /** Le pagine di questo file che vanno nel calendario. */
    private scopeOf: (file: TFile, ids: string[]) => string[],
    /** Data della nota (es. la nota del giorno) per i task con il solo orario. */
    private dateOf: (file: TFile) => string | null,
    private log: (m: string) => void
  ) {}

  /** Una nota è cambiata: allinea il calendario dopo qualche secondo (le modifiche arrivano a raffica). */
  schedule(file: TFile, delayMs = 3000): void {
    const s = this.settings();
    if (!s.calendarEnabled) return;
    const prev = this.timers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.timers.set(
      file.path,
      window.setTimeout(() => {
        this.timers.delete(file.path);
        this.chain = this.chain.then(() =>
          this.syncFile(file).then(
            () => undefined,
            (e) => this.log(`Calendario: ${(e as Error)?.message ?? e}`)
          )
        );
      }, delayMs)
    );
  }

  async syncFile(file: TFile): Promise<number> {
    const s = this.settings();
    if (!s.calendarEnabled) return 0;
    if (!this.app.vault.getAbstractFileByPath(file.path)) return 0;
    const content = await this.app.vault.read(file);
    const scope = this.scopeOf(file, blockIds(content));
    if (!scope.length) return 0;
    const tasks = tasksInBlocks(content, scope);
    const link = `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(file.path)}`;
    const noteDate = this.dateOf(file);
    const target: TasksTarget = s.tasksTarget ?? (s.googleTasks === false ? "none" : "google");
    const { ops, hashes } = planCalendar(tasks, scope, s.calendarEvents, {
      minutes: s.eventMinutes,
      allDay: s.calendarAllDay,
      target,
      tz: s.eventTimezone || "device",
      tasksList: s.tasksList,
      fallbackDate: noteDate ?? moment().format("YYYY-MM-DD"),
      taskDate: noteDate,
      description: `Scritto a mano · ${file.basename}\n${link}`,
    });
    if (!ops.length) return 0;

    // risultati nello stesso ordine delle operazioni
    const results: ({ ok: boolean; id?: string; error?: string } | undefined)[] = new Array(ops.length);
    const google = ops.map((op, i) => ({ op, i })).filter((x) => x.op.kind !== "todoist");
    if (google.length) {
      if (!s.calendarUrl) {
        for (const g of google) results[g.i] = { ok: false, error: "manca l'URL dello script di Google (Impostazioni → Neo Pen)" };
      } else {
        const res = await callCalendar(
          s.calendarUrl,
          s.calendarSecret,
          s.calendarId,
          google.map(({ op }) => {
            const { fullKey, ...rest } = op;
            return rest as CalendarOp;
          })
        );
        google.forEach((g, j) => (results[g.i] = res[j]));
      }
    }
    const todo = ops.map((op, i) => ({ op, i })).filter((x) => x.op.kind === "todoist");
    if (todo.length) {
      const client = new Todoist(s.todoistToken);
      for (const { op, i } of todo) {
        try {
          if (op.action === "delete") {
            if (op.id) await client.remove(op.id);
            results[i] = { ok: true };
          } else {
            const id = await client.upsert(
              op.id,
              { content: op.title ?? "", description: op.description ?? "", date: op.date ?? "", done: !!op.done },
              s.todoistProject
            );
            results[i] = { ok: true, id };
          }
        } catch (e) {
          results[i] = { ok: false, error: (e as Error)?.message ?? String(e) };
          if (/token/.test(results[i]!.error!)) {
            // token mancante o sbagliato: inutile insistere con le altre
            for (const rest of todo) if (!results[rest.i]) results[rest.i] = { ok: false, error: results[i]!.error };
            break;
          }
        }
      }
    }

    let created = 0,
      updated = 0,
      removed = 0,
      failed = 0;
    let tasksMissing = false;
    const errors = new Set<string>();
    ops.forEach((op, i) => {
      const r = results[i];
      const key = op.fullKey;
      if (!r?.ok) {
        failed++;
        if (r?.error === "tasks-service") tasksMissing = true;
        else if (r?.error) errors.add(r.error);
        return;
      }
      if (op.action === "delete") {
        // se lo stesso task è stato appena ricreato altrove (evento → attività) la voce nuova arriva dopo
        if (!hashes[key]) delete s.calendarEvents[key];
        removed++;
      } else if (r.id) {
        if (s.calendarEvents[key] && (s.calendarEvents[key].kind ?? "event") === hashes[key].kind) updated++;
        else created++;
        s.calendarEvents[key] = { id: r.id, ...hashes[key] };
      }
    });
    if (tasksMissing) {
      this.log("Google Tasks: nello script manca il servizio «Google Tasks API». Aprilo su script.google.com → Servizi (+) → Google Tasks API → Aggiungi, poi ripubblica (Gestisci deployment → Nuova versione).");
    }
    for (const e of errors) this.log(`Calendario e attività: ${e}`);
    await this.save();
    const parts = [
      created && `${created} ${created === 1 ? "creato" : "creati"}`,
      updated && `${updated} ${updated === 1 ? "aggiornato" : "aggiornati"}`,
      removed && `${removed} ${removed === 1 ? "tolto" : "tolti"}`,
      failed && `${failed} non riusciti`,
    ].filter(Boolean);
    if (parts.length) this.log(`Calendario e attività (${file.basename}): ${parts.join(", ")}.`);
    return ops.length - failed;
  }
}
