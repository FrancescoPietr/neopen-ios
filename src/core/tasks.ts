// Tasks live in the Obsidian vault, as markdown checkbox lines, so the pen, the app and Obsidian all see the same thing.
// The format is the one of the Obsidian "Tasks" plugin plus the Neo Pen time prefix:
//   - [ ] 15:00-16:00 call Marco #lavoro ⏫ 🔁 every week 📅 2026-10-24 ✅ 2026-10-23
// Priorities (Todoist p1..p4): 🔺 p1, ⏫ p2, 🔼 p3, none p4 (🔽 = p4 too).
// Projects: a task in "Attività/<Nome>.md" belongs to project <Nome> ("Inbox" for Attività/Inbox.md); a task in any
// other note belongs to that note; tasks in daily notes are dated by the note when they have no 📅.

export type Priority = 1 | 2 | 3 | 4;

export interface VaultTask {
  /** "<file>#<line>": stable while the file does not change above the line. */
  id: string;
  file: string;
  line: number;
  indent: number;
  done: boolean;
  /** Text as written (with #tags, without time, priority, recurrence and dates). */
  text: string;
  /** Text without #tags, for display. */
  title: string;
  labels: string[];
  /** YYYY-MM-DD: 📅 date, or the daily note's date. */
  date: string | null;
  /** The date comes from the daily note (not written on the line). */
  dateFromNote: boolean;
  time: string | null;
  end: string | null;
  priority: Priority;
  /** e.g. "every week", "every monday", "every 2 days". */
  recurrence: string | null;
  doneDate: string | null;
  project: string;
  /** id of the parent task (sub-task = more indented right below it). */
  parent: string | null;
  /** Obsidian block id at the end of the line (" ^abc"), e.g. "penna-…" for tasks the phone added from the pen. */
  blockId: string | null;
}

export const TASKS_FOLDER = "Attività";
export const INBOX = "Inbox";

const TASK_LINE = /^(\s*)[-*] \[([ xX])\] (.*)$/;
const PRI: Record<string, Priority> = { "🔺": 1, "⏫": 2, "🔼": 3, "🔽": 4 };
const PRI_EMOJI: Record<Priority, string> = { 1: "🔺", 2: "⏫", 3: "🔼", 4: "" };

export interface FileContext {
  /** Vault-relative path, e.g. "Daily/2026-10-23.md". */
  path: string;
  /** YYYY-MM-DD if the file is a daily note. */
  dailyDate?: string | null;
}

/** Project of a file: "Attività/Lavoro.md" → "Lavoro", daily notes → "Diario", other notes → their name. */
export function projectOf(ctx: FileContext): string {
  const parts = ctx.path.split("/");
  const name = parts[parts.length - 1].replace(/\.md$/i, "");
  if (ctx.dailyDate) return "Diario";
  return name;
}

/** Inside a fenced code block or a Neo Pen drawing block nothing is a task. */
function fenceToggle(line: string): boolean {
  return /^\s*```/.test(line);
}

export function parseTaskLine(raw: string): Omit<VaultTask, "id" | "file" | "line" | "project" | "parent" | "dateFromNote"> | null {
  const m = TASK_LINE.exec(raw);
  if (!m) return null;
  const indent = m[1].replace(/\t/g, "    ").length;
  const done = m[2] !== " ";
  let rest = m[3];
  let blockId: string | null = null;
  const b = /\s+\^([A-Za-z0-9-]+)\s*$/.exec(rest);
  if (b) {
    blockId = b[1];
    rest = rest.slice(0, b.index);
  }
  let doneDate: string | null = null;
  let date: string | null = null;
  let recurrence: string | null = null;
  let priority: Priority = 4;
  // from the end: ✅ done date, 📅 due date, 🔁 recurrence, priority (in any order, as the Tasks plugin writes them)
  for (let changed = true; changed; ) {
    changed = false;
    let x = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/u.exec(rest);
    if (x) {
      doneDate = x[1];
      rest = rest.slice(0, x.index);
      changed = true;
    }
    x = /\s*📅\s*(\d{4}-\d{2}-\d{2})\s*$/u.exec(rest);
    if (x) {
      date = x[1];
      rest = rest.slice(0, x.index);
      changed = true;
    }
    x = /\s*🔁\s*([^🔺⏫🔼🔽📅✅]+?)\s*$/u.exec(rest);
    if (x) {
      recurrence = x[1].trim();
      rest = rest.slice(0, x.index);
      changed = true;
    }
    x = /\s*([🔺⏫🔼🔽])\s*$/u.exec(rest);
    if (x) {
      priority = PRI[x[1]];
      rest = rest.slice(0, x.index);
      changed = true;
    }
  }
  let time: string | null = null;
  let end: string | null = null;
  const t = /^(\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2}))?\s+/.exec(rest);
  if (t && Number(t[1]) < 24 && Number(t[2]) < 60) {
    time = `${t[1].padStart(2, "0")}:${t[2]}`;
    if (t[3]) end = `${t[3].padStart(2, "0")}:${t[4]}`;
    rest = rest.slice(t[0].length);
  }
  const text = rest.trim();
  const labels = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)].map((l) => l[1].toLowerCase());
  const title = text.replace(/(?:^|\s)#[\p{L}\p{N}_\-/]+/gu, "").replace(/\s{2,}/g, " ").trim() || text;
  return { indent, done, text, title, labels, date, time, end, priority, recurrence, doneDate, blockId };
}

/** All tasks of a markdown file. */
export function parseTasks(content: string, ctx: FileContext): VaultTask[] {
  const out: VaultTask[] = [];
  const stack: VaultTask[] = [];
  let fence = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (fenceToggle(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const p = parseTaskLine(line);
    if (!p) {
      if (line.trim() && !/^\s/.test(line)) stack.length = 0; // a non-indented line ends the nesting
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= p.indent) stack.pop();
    const parent = stack[stack.length - 1];
    const task: VaultTask = {
      ...p,
      id: `${ctx.path}#${i}`,
      file: ctx.path,
      line: i,
      date: p.date ?? (ctx.dailyDate ?? null),
      dateFromNote: !p.date && !!ctx.dailyDate,
      project: projectOf(ctx),
      parent: parent ? parent.id : null,
    };
    out.push(task);
    stack.push(task);
  }
  return out;
}

/** Fields that can be written back. */
export interface TaskFields {
  done: boolean;
  text: string;
  date: string | null;
  time: string | null;
  end: string | null;
  priority: Priority;
  recurrence: string | null;
  doneDate: string | null;
  blockId?: string | null;
}

/** The markdown line for a task (indentation as a string, e.g. "\t"). */
export function formatTaskLine(f: TaskFields, indent = "", dateFromNote = false): string {
  const parts: string[] = [];
  if (f.time) parts.push(f.end ? `${f.time}-${f.end}` : f.time);
  parts.push(f.text.trim());
  if (PRI_EMOJI[f.priority]) parts.push(PRI_EMOJI[f.priority]);
  if (f.recurrence) parts.push(`🔁 ${f.recurrence}`);
  if (f.date && !dateFromNote) parts.push(`📅 ${f.date}`);
  if (f.done && f.doneDate) parts.push(`✅ ${f.doneDate}`);
  if (f.blockId) parts.push(`^${f.blockId}`);
  return `${indent}- [${f.done ? "x" : " "}] ${parts.join(" ")}`;
}

/** Replaces line `line` of `content` (checking it is still the same task) with `newLines`. Null if the line moved. */
export function replaceLine(content: string, line: number, expected: string, newLines: string[]): string | null {
  const lines = content.split("\n");
  const cur = (lines[line] ?? "").replace(/\r$/, "");
  if (cur !== expected.replace(/\r$/, "")) return null;
  lines.splice(line, 1, ...newLines);
  return lines.join("\n");
}

// ---------------------------------------------------------------- dates and recurrence

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Next date of a recurrence ("every day/week/month/year", "every 2 weeks", "every monday, thursday", "every weekday"). */
export function nextOccurrence(recurrence: string, from: string): string | null {
  const r = recurrence.toLowerCase().replace(/\s+when done$/, "").trim();
  const n = /^every (\d+) (day|week|month|year)s?$/.exec(r);
  const unit = n ? n[2] : /^every (day|week|month|year)$/.exec(r)?.[1];
  const count = n ? Number(n[1]) : 1;
  if (unit) {
    const d = parseYmd(from);
    if (unit === "day") d.setDate(d.getDate() + count);
    if (unit === "week") d.setDate(d.getDate() + 7 * count);
    if (unit === "month") {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + count);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    }
    if (unit === "year") d.setFullYear(d.getFullYear() + count);
    return ymd(d);
  }
  if (r === "every weekday") {
    let d = addDays(from, 1);
    while ([0, 6].includes(parseYmd(d).getDay())) d = addDays(d, 1);
    return d;
  }
  const w = /^every ((?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*(?:,|and)\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))*)$/.exec(r);
  if (w) {
    const want = new Set(w[1].split(/\s*(?:,|and)\s*/).map((x) => DAYS.indexOf(x.trim())));
    let d = addDays(from, 1);
    for (let i = 0; i < 8; i++, d = addDays(d, 1)) if (want.has(parseYmd(d).getDay())) return d;
  }
  return null;
}

/**
 * Lines that replace a task when you tick or untick it. A recurring task, when completed, gets a new open copy with the
 * next date above the completed one (like the Tasks plugin), so the history stays in the note.
 */
export function toggleLines(t: VaultTask, today: string, indent = ""): string[] {
  const base: TaskFields = { done: t.done, text: t.text, date: t.date, time: t.time, end: t.end, priority: t.priority, recurrence: t.recurrence, doneDate: t.doneDate, blockId: t.blockId };
  if (t.done) return [formatTaskLine({ ...base, done: false, doneDate: null }, indent, t.dateFromNote)];
  const doneLine = formatTaskLine({ ...base, done: true, doneDate: today }, indent, t.dateFromNote);
  if (!t.recurrence) return [doneLine];
  const next = nextOccurrence(t.recurrence, t.date ?? today);
  if (!next) return [doneLine];
  return [formatTaskLine({ ...base, done: false, doneDate: null, date: next, blockId: null }, indent), doneLine];
}
