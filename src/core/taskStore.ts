// The tasks of the whole vault, built from the markdown files, plus the edits (they return the new file text).
import { QuickAdd } from "./quickadd";
import { INBOX, Priority, TASKS_FOLDER, VaultTask, formatTaskLine, parseTasks, replaceLine, toggleLines } from "./tasks";

export interface DailyConfig {
  folder: string;
  /** moment.js format of the daily note names (only the common ones are understood). */
  format: string;
}

/** Folders whose tasks are not real tasks (templates, bin, plugin internals). */
export const SKIPPED = [/^Templates?\//i, /^NeoPen\/_/, /^\.trash\//];

/** Date of a daily note from its path, or null. Formats: YYYY-MM-DD (default), DD-MM-YYYY, YYYYMMDD. */
export function dailyDateOf(path: string, cfg: DailyConfig): string | null {
  const folder = cfg.folder.replace(/^\/+|\/+$/g, "");
  if (folder && !path.startsWith(folder + "/")) return null;
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  const f = (cfg.format || "YYYY-MM-DD").trim();
  let m: RegExpExecArray | null;
  if (f === "YYYY-MM-DD" && (m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name))) return `${m[1]}-${m[2]}-${m[3]}`;
  if (f === "DD-MM-YYYY" && (m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(name))) return `${m[3]}-${m[2]}-${m[1]}`;
  if (f === "YYYYMMDD" && (m = /^(\d{4})(\d{2})(\d{2})$/.exec(name))) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export interface VaultFileText {
  path: string;
  text: string;
}

export function buildIndex(files: VaultFileText[], cfg: DailyConfig): VaultTask[] {
  const out: VaultTask[] = [];
  for (const f of files) {
    if (SKIPPED.some((re) => re.test(f.path))) continue;
    out.push(...parseTasks(f.text, { path: f.path, dailyDate: dailyDateOf(f.path, cfg) }));
  }
  return out;
}

// ---------------------------------------------------------------- views

export const isOpen = (t: VaultTask) => !t.done;

/** Open tasks dated before `today` (overdue), oldest first. */
export function overdue(tasks: VaultTask[], today: string): VaultTask[] {
  return tasks.filter((t) => isOpen(t) && t.date && t.date < today).sort(byDateTime);
}

/** Tasks of one day: open ones, then the done ones. */
export function onDay(tasks: VaultTask[], day: string): VaultTask[] {
  return tasks.filter((t) => t.date === day).sort((a, b) => Number(a.done) - Number(b.done) || byDateTime(a, b));
}

export function byDateTime(a: VaultTask, b: VaultTask): number {
  return (a.date ?? "9999").localeCompare(b.date ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99") || a.priority - b.priority || a.title.localeCompare(b.title);
}

/** Projects: Inbox first, then the files in the tasks folder, then the other notes with open tasks. */
export function projects(tasks: VaultTask[]): { name: string; file: string; open: number; own: boolean }[] {
  const map = new Map<string, { name: string; file: string; open: number; own: boolean }>();
  for (const t of tasks) {
    if (t.project === "Diario") continue;
    const own = t.file.startsWith(TASKS_FOLDER + "/");
    const cur = map.get(t.file) ?? { name: t.project, file: t.file, open: 0, own };
    if (!t.done) cur.open++;
    map.set(t.file, cur);
  }
  const list = [...map.values()].filter((p) => p.own || p.open > 0);
  return list.sort((a, b) => Number(b.name === INBOX) - Number(a.name === INBOX) || Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
}

export function labels(tasks: VaultTask[]): { name: string; open: number }[] {
  const map = new Map<string, number>();
  for (const t of tasks) if (!t.done) for (const l of t.labels) map.set(l, (map.get(l) ?? 0) + 1);
  return [...map.entries()].map(([name, open]) => ({ name, open })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- edits (they return the new text of the file)

export function projectFile(project: string | null): string {
  const name = (project || INBOX).replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || INBOX;
  return `${TASKS_FOLDER}/${name}.md`;
}

/** New task at the end of a project file (created if missing). */
export function appendTask(fileText: string | null, q: Pick<QuickAdd, "title" | "date" | "time" | "end" | "recurrence" | "priority" | "labels">, project: string): string {
  const text = [q.title, ...q.labels.map((l) => `#${l}`)].join(" ").trim();
  const line = formatTaskLine({ done: false, text, date: q.date, time: q.time, end: q.end, priority: q.priority, recurrence: q.recurrence, doneDate: null });
  if (fileText === null || !fileText.trim()) return `# ${project}\n\n${line}\n`;
  return fileText.replace(/\s*$/, "") + "\n" + line + "\n";
}

const indentOf = (raw: string) => /^\s*/.exec(raw)![0];

/** The current text of a task's line (to check the file has not moved under us). */
export function lineOf(fileText: string, t: VaultTask): string {
  return (fileText.split("\n")[t.line] ?? "").replace(/\r$/, "");
}

export function toggleTask(fileText: string, t: VaultTask, today: string): string | null {
  const raw = lineOf(fileText, t);
  return replaceLine(fileText, t.line, raw, toggleLines(t, today, indentOf(raw)));
}

export interface TaskEdit {
  text?: string;
  date?: string | null;
  time?: string | null;
  end?: string | null;
  priority?: Priority;
  recurrence?: string | null;
}

export function editTask(fileText: string, t: VaultTask, e: TaskEdit): string | null {
  const raw = lineOf(fileText, t);
  const dateChanged = e.date !== undefined && e.date !== t.date;
  const line = formatTaskLine(
    {
      done: t.done,
      text: e.text ?? t.text,
      date: e.date !== undefined ? e.date : t.date,
      time: e.time !== undefined ? e.time : t.time,
      end: e.end !== undefined ? e.end : t.end,
      priority: e.priority ?? t.priority,
      recurrence: e.recurrence !== undefined ? e.recurrence : t.recurrence,
      doneDate: t.doneDate,
      blockId: t.blockId,
    },
    indentOf(raw),
    t.dateFromNote && !dateChanged
  );
  return replaceLine(fileText, t.line, raw, [line]);
}

/** Removes the task line (and its sub-tasks). */
export function deleteTask(fileText: string, t: VaultTask, all: VaultTask[]): string | null {
  const raw = lineOf(fileText, t);
  const lines = fileText.split("\n");
  if ((lines[t.line] ?? "").replace(/\r$/, "") !== raw) return null;
  const kids = all.filter((x) => x.file === t.file && isDescendant(x, t, all)).map((x) => x.line);
  const drop = new Set([t.line, ...kids]);
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

function isDescendant(x: VaultTask, of: VaultTask, all: VaultTask[]): boolean {
  let p = x.parent;
  while (p) {
    if (p === of.id) return true;
    p = all.find((y) => y.id === p)?.parent ?? null;
  }
  return false;
}
