// Quick add in plain Italian, like Todoist's and Fantastical's: the words for dates, times, repetitions, priority,
// #labels and +project are recognized and removed from the title.
//   "dentista venerdì alle 15 #salute p1"            → venerdì, 15:00, label salute, priority 1
//   "riunione dalle 9 alle 10:30 domani +Lavoro"     → domani, 09:00-10:30, project Lavoro
//   "pagare affitto ogni mese il 1"                  → recurring every month, from the 1st
//   "cena con Anne sabato alle 20 per 2 ore"         → 20:00-22:00

import { Priority, addDays, parseYmd, ymd } from "./tasks";

export interface QuickAdd {
  title: string;
  date: string | null;
  time: string | null;
  end: string | null;
  recurrence: string | null;
  priority: Priority;
  labels: string[];
  project: string | null;
  /** Pieces of the input that were understood (for highlighting), in order. */
  matched: string[];
}

const WEEKDAYS: Record<string, number> = {
  domenica: 0, lunedi: 1, lunedì: 1, martedi: 2, martedì: 2, mercoledi: 3, mercoledì: 3,
  giovedi: 4, giovedì: 4, venerdi: 5, venerdì: 5, sabato: 6,
  dom: 0, lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6,
};
const EN_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
};
const DAY_RE = "(domenica|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato)";
const MONTH_RE = "(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)";
const TIME_RE = "(\\d{1,2})(?:[:.](\\d{2}))?";

const pad = (n: number) => String(n).padStart(2, "0");

/** Next date (today included) that falls on weekday `wd`. */
function nextWeekday(today: string, wd: number, skipToday = false): string {
  let d = today;
  for (let i = 0; i < 8; i++) {
    if (parseYmd(d).getDay() === wd && !(skipToday && i === 0)) return d;
    d = addDays(d, 1);
  }
  return today;
}

/** Day and month without a year: this year, or the next one if already past. */
function dayMonth(today: string, day: number, month: number, year?: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = parseYmd(today);
  let y = year ?? t.getFullYear();
  if (year !== undefined && year < 100) y = 2000 + year;
  let d = new Date(y, month - 1, day);
  if (d.getMonth() !== month - 1) return null;
  if (year === undefined && ymd(d) < today) d = new Date(y + 1, month - 1, day);
  return ymd(d);
}

function hm(h: string, m?: string): string | null {
  const H = Number(h),
    M = m ? Number(m) : 0;
  return H < 24 && M < 60 ? `${pad(H)}:${pad(M)}` : null;
}

export function parseQuickAdd(input: string, today: string): QuickAdd {
  let s = ` ${input.trim()} `;
  const out: QuickAdd = { title: "", date: null, time: null, end: null, recurrence: null, priority: 4, labels: [], project: null, matched: [] };
  /** Removes the first match of `re` (with spaces around) and returns it. */
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (!m) return null;
    out.matched.push(m[0].trim());
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return m;
  };
  const b = (core: string) => new RegExp(`(?<=\\s)${core}(?=[\\s,.;!?]|$)`, "iu");

  // priority, labels, project
  let m = take(b("p([1-4])"));
  if (m) out.priority = Number(m[1]) as Priority;
  else if (take(b("(?:urgente|!!!)"))) out.priority = 1;
  while ((m = take(/(?<=\s)#([\p{L}\p{N}_\-/]+)/u))) out.labels.push(m[1]);
  m = take(/(?<=\s)\+([\p{L}\p{N}_\-]+(?:\s[A-Z][\p{L}\p{N}_\-]*)*)/u);
  if (m) out.project = m[1];

  // repetitions
  if ((m = take(b("ogni (\\d+) (giorni|settimane|mesi|anni)")))) {
    const unit = { giorni: "days", settimane: "weeks", mesi: "months", anni: "years" }[m[2].toLowerCase()];
    out.recurrence = `every ${m[1]} ${unit}`;
  } else if ((m = take(b("ogni (giorno feriale|giorno lavorativo)")))) out.recurrence = "every weekday";
  else if ((m = take(b("(?:ogni|tutti i|tutte le) (giorno|giorni|settimana|settimane|mese|mesi|anno|anni)")))) {
    const w = m[1].toLowerCase();
    out.recurrence = `every ${w.startsWith("giorn") ? "day" : w.startsWith("settiman") ? "week" : w.startsWith("mes") ? "month" : "year"}`;
  } else if ((m = take(b(`(?:ogni|tutti i|tutte le) ${DAY_RE}(?:\\s*(?:,|e)\\s*${DAY_RE})?`)))) {
    const days = [m[1], m[2]].filter(Boolean).map((d) => EN_DAYS[WEEKDAYS[d.toLowerCase()]]);
    out.recurrence = `every ${days.join(", ")}`;
    out.date = nextWeekday(today, WEEKDAYS[m[1].toLowerCase()]);
  } else if ((m = take(b("(?:quotidiano|quotidianamente|giornaliero)")))) out.recurrence = "every day";
  else if ((m = take(b("settimanale")))) out.recurrence = "every week";
  else if ((m = take(b("mensile")))) out.recurrence = "every month";

  // times: "dalle 9 alle 11", "14:00-15:30", "alle 15", "ore 9", "h 18", "per 2 ore"
  if ((m = take(b(`dalle ${TIME_RE} alle ${TIME_RE}`)))) {
    out.time = hm(m[1], m[2]);
    out.end = hm(m[3], m[4]);
  } else if ((m = take(b(`${TIME_RE}\\s*-\\s*${TIME_RE}`))) && (m[2] || m[4])) {
    out.time = hm(m[1], m[2]);
    out.end = hm(m[3], m[4]);
  } else {
    if (m) {
      // "3-4" without minutes is not a time: put it back
      s = s.replace(/\s+/, ` ${m[0].trim()} `);
      out.matched.pop();
    }
    if ((m = take(b(`(?:alle|all'|ore|h|verso le)\\s*${TIME_RE}`)) ?? take(b("(\\d{1,2})[:.](\\d{2})")))) out.time = hm(m[1], m[2]);
  }
  if (out.time && (out.time < "07:00") && /pomeriggio|sera/i.test(s)) {
    const h = Number(out.time.slice(0, 2)) + 12;
    out.time = `${pad(h)}:${out.time.slice(3)}`;
  }
  take(b("(?:di |del |nel )?(?:pomeriggio|sera|mattina)"));
  if ((m = take(b("per (\\d+) (minuti|min|ore|ora|h)"))) && out.time) {
    const mins = /^m/i.test(m[2]) ? Number(m[1]) : Number(m[1]) * 60;
    const [h, mi] = out.time.split(":").map(Number);
    const tot = h * 60 + mi + mins;
    if (tot < 24 * 60) out.end = `${pad(Math.floor(tot / 60))}:${pad(tot % 60)}`;
  } else if ((m = take(b("per (un'ora|mezz'ora)"))) && out.time) {
    const mins = /mezz/.test(m[1]) ? 30 : 60;
    const [h, mi] = out.time.split(":").map(Number);
    const tot = h * 60 + mi + mins;
    if (tot < 24 * 60) out.end = `${pad(Math.floor(tot / 60))}:${pad(tot % 60)}`;
  }

  // dates
  if (!out.date) {
    if ((m = take(b("(?:oggi|stasera|stamattina|stanotte)")))) out.date = today;
    else if ((m = take(b("dopodomani")))) out.date = addDays(today, 2);
    else if ((m = take(b("domani")))) out.date = addDays(today, 1);
    else if ((m = take(b("tra (\\d+) (giorni|settimane)")))) out.date = addDays(today, Number(m[1]) * (/sett/.test(m[2]) ? 7 : 1));
    else if ((m = take(b("(?:la )?prossima settimana")))) out.date = nextWeekday(today, 1, true);
    else if ((m = take(b("(?:il )?fine settimana|weekend")))) out.date = nextWeekday(today, 6);
    else if ((m = take(b(`(?:il )?(\\d{1,2}) ${MONTH_RE}(?: (\\d{4}))?`)))) out.date = dayMonth(today, Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : undefined);
    else if ((m = take(b("(?:il )?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?")))) out.date = dayMonth(today, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    else if ((m = take(b(`(?:il |la |questo |questa |prossimo |prossima )?${DAY_RE}(?: prossim[oa])?`)))) out.date = nextWeekday(today, WEEKDAYS[m[1].toLowerCase()], /prossim/i.test(m[0]));
    else if (out.recurrence?.startsWith("every month") && (m = take(b("il (\\d{1,2})")))) {
      // il giorno N di questo mese, o del prossimo se è già passato
      const t = parseYmd(today);
      const day = Number(m[1]);
      let d = new Date(t.getFullYear(), t.getMonth(), day);
      if (ymd(d) < today) d = new Date(t.getFullYear(), t.getMonth() + 1, day);
      out.date = day >= 1 && day <= 31 ? ymd(d) : null;
    }
  }
  if (out.recurrence && !out.date) out.date = today;

  out.title = s
    .replace(/\s+/g, " ")
    .replace(/\s([,.;])/g, "$1")
    .replace(/^[\s,.;-]+|[\s,;-]+$/g, "")
    .trim();
  return out;
}
