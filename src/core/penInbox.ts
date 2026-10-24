// Where the phone puts what you write with the pen (no PC, no Obsidian open):
// - tasks without a time → the daily note of the day you wrote them, under "### Attività" (like the #task pages of
//   the Obsidian plugin). Each line ends with a block id "^penna-…": when the plugin later transcribes the page it
//   takes that line over (keeping the tick if you ticked it in the app), so nothing is doubled.
// - tasks with a time → an event in the iPhone calendar (see phoneEvents.ts).
import { formatTaskLine, ymd } from "./tasks";

export interface DailyNotesConfig {
  folder: string;
  format: string;
  template: string;
}

export const PEN_HEADING = "### Attività";
export const PEN_BLOCK = "penna-";

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const DAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** moment.js-style formatting (the common tokens), Italian names. */
export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|dd|d|HH|H|mm|ss/g, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return String(d.getFullYear()).slice(2);
      case "MMMM": return MONTHS[d.getMonth()];
      case "MMM": return MONTHS[d.getMonth()].slice(0, 3);
      case "MM": return p2(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "DD": return p2(d.getDate());
      case "Do": return `${d.getDate()}º`;
      case "D": return String(d.getDate());
      case "dddd": return DAYS[d.getDay()];
      case "ddd": return DAYS[d.getDay()].slice(0, 3);
      case "dd": return DAYS[d.getDay()].slice(0, 2);
      case "d": return String(d.getDay());
      case "HH": return p2(d.getHours());
      case "H": return String(d.getHours());
      case "mm": return p2(d.getMinutes());
      case "ss": return p2(d.getSeconds());
    }
    return t;
  });
}

const dayDate = (day: string, now: Date) => {
  const [y, m, dd] = day.split("-").map(Number);
  return new Date(y, m - 1, dd, now.getHours(), now.getMinutes(), now.getSeconds());
};

/** Path of the daily note of `day` (YYYY-MM-DD). */
export function dailyPath(cfg: DailyNotesConfig, day: string): string {
  const name = formatDate(dayDate(day, new Date(2000, 0, 1)), (cfg.format || "YYYY-MM-DD").trim());
  const folder = cfg.folder.replace(/^\/+|\/+$/g, "");
  return `${folder ? folder + "/" : ""}${name}.md`;
}

/**
 * The daily-note template filled in for `day`: core-template variables ({{date}}, {{date:FMT}}, {{time}}, {{title}})
 * and the simple Templater expressions (`<% d.format("…") %>`, `<% tp.date.now("…") %>`, `.locale("it")`,
 * `.toLowerCase()`). Templater code blocks (`<%* … %>`) are dropped.
 */
export function fillTemplate(tpl: string, day: string, title: string, now = new Date()): string {
  const d = dayDate(day, now);
  const evalExpr = (expr: string): string => {
    const e = expr.trim();
    if (/^tp\.file\.title$/.test(e)) return title;
    let m = /^tp\.date\.now\(\s*["']([^"']*)["']\s*\)$/.exec(e);
    if (m) return formatDate(now, m[1]);
    m = /^[\w.()"' ,]*?\.format\(\s*["']([^"']*)["']\s*\)(\.toLowerCase\(\)|\.toUpperCase\(\))?$/.exec(e);
    if (m) {
      const out = formatDate(d, m[1]);
      return m[2] === ".toLowerCase()" ? out.toLowerCase() : m[2] === ".toUpperCase()" ? out.toUpperCase() : out;
    }
    return "";
  };
  return tpl
    .replace(/<%\*[\s\S]*?(-?)%>(\r?\n)?/g, (_m, dash, nl) => (dash ? "" : nl ?? ""))
    .replace(/<%[-_]?([\s\S]*?)[-_]?%>/g, (_m, expr) => evalExpr(expr))
    .replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/g, (_m, f) => formatDate(d, f))
    .replace(/\{\{\s*time\s*:\s*([^}]+?)\s*\}\}/g, (_m, f) => formatDate(now, f))
    .replace(/\{\{\s*date\s*\}\}/g, day)
    .replace(/\{\{\s*time\s*\}\}/g, formatDate(now, "HH:mm"))
    .replace(/\{\{\s*title\s*\}\}/g, title);
}

export function penBlockId(seed = Date.now()): string {
  return `${PEN_BLOCK}${seed.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

export interface PenTodo {
  title: string;
  /** YYYY-MM-DD written on the task, or "". */
  date: string;
}

/**
 * Adds the tasks to a daily note (its text, or null if it does not exist yet: then `template` starts it).
 * They go at the end of the "Attività" section (created at the end of the note if missing).
 */
export function addToDaily(text: string | null, todos: PenTodo[], day: string, template: string | null, now = new Date()): string {
  const lines = todos.map((t, i) =>
    formatTaskLine({
      done: false,
      text: t.title.trim(),
      date: t.date && t.date !== day ? t.date : null,
      time: null,
      end: null,
      priority: 4,
      recurrence: null,
      doneDate: null,
      blockId: penBlockId(now.getTime() + i),
    })
  );
  let content = text ?? (template !== null ? fillTemplate(template, day, day, now) : "");
  content = content.replace(/\r\n/g, "\n");
  const all = content.split("\n");
  const idx = all.findIndex((l) => /^#{1,6}\s+attivit[àa]\s*$/i.test(l.trim()));
  if (idx < 0) {
    const base = content.replace(/\s*$/, "");
    return `${base ? base + "\n\n" : ""}${PEN_HEADING}\n\n${lines.join("\n")}\n`;
  }
  const level = /^#+/.exec(all[idx].trim())![0].length;
  let end = all.length;
  for (let i = idx + 1; i < all.length; i++) {
    const h = /^(#+)\s/.exec(all[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > idx + 1 && all[at - 1].trim() === "") at--;
  // right under the heading: one empty line first; after other tasks: straight below them
  const prev = all[at - 1] ?? "";
  const gap = at === idx + 1 || !/^\s*[-*] \[/.test(prev) ? [""] : [];
  all.splice(at, 0, ...gap, ...lines, ...(end < all.length ? [""] : []));
  let out = all.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

export const today = () => ymd(new Date());
