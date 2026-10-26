// Tasks written with the pen, read straight on the phone (PC off, Obsidian closed): those with a TIME become events in
// the iPhone calendar, the others go into the daily note of the vault. The rest (notes, ticks, deletions) is done by
// the Obsidian plugin when it transcribes the page.

import { PageRecord, Stroke } from "./models";

export const EVENTS_MODEL = "claude-sonnet-5-5";

const SYSTEM = `You read a handwritten notebook page captured by a smartpen. The writing is mostly Italian, often fast cursive.
INK: BLACK ink was written just now. GRAY ink was written earlier and is already handled: use it only as context.

Find the TASKS that have something new in BLACK. A task is a line that starts with a hand-drawn box (a small square) followed by an action; it can continue on the next line (indented, without a box): join it.
Report a task when:
- it is written in BLACK (a new task), or
- it is GRAY but a time, a date or words were just added to it in BLACK (then give the whole task, gray and black words together), or
- it is GRAY and its box was just ticked or crossed in BLACK (a tick ✓, an X or a filled box, even a quick stroke that goes past the box): it was just done. Give its gray words as title, its gray time as start, and done=true.
Never report a task that is all gray with nothing black in or on its box. Skip tasks whose words are struck through.
For each task write {title, start, end, date, done}:
- title: the task text as written, WITHOUT the box, the time and the day words (read cursive word by word with the sentence context; keep #tags).
- start: "HH:MM" (24h) if a time is written ("alle 15", "15:30", "ore 9", "h 18", "dalle 9 alle 11"), else "".
- end: "HH:MM" for a time range, else "".
- date: "YYYY-MM-DD" if a day is written ("oggi", "domani", "dopodomani", a weekday, "17/10"), computed from TODAY given below (a weekday means the next one, today included); else "".
- done: true if its box is ticked or crossed (in any ink), else false.
Plain notes, lists without boxes and drawings are not tasks. If there are none, tasks is [].
TAGS ARE NOT TASKS: a "#" (two pairs of crossed lines, like a hash or a small grid, often drawn big and fast) followed by a word is a TAG that says what the page or the note is about (e.g. "#taccuino", "#task", "#cinema"), never a box: a line with "#word" is NOT a task, even if the "#" looks like a crossed box. A task box is a closed square (four sides), empty, ticked or crossed, followed by an action. A word right after a "#" that is one of the author's tags (listed below) is always a tag.`;

const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, date: { type: "string" }, done: { type: "boolean" } },
        required: ["title", "start", "end", "date", "done"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

/** YYYY-MM-DD in the phone's time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ink strokes written after `upTo` (pen-down time). */
export function strokesAfter(r: PageRecord, upTo: number): Stroke[] {
  return r.strokes.filter((s) => s.t > upTo && s.tip !== 1 && s.pts.length >= 3);
}

/** Request body for the Messages API. `writtenAt` = when the strokes were written (for "oggi", "domani"…). */
export function eventsRequest(pngBase64: string, size: { width: number; height: number }, writtenAt: number, model = EVENTS_MODEL, tags: string[] = []): string {
  const today = localDay(writtenAt);
  const wd = WEEKDAYS[new Date(writtenAt).getDay()];
  const known = tags.length ? ` The author's tags: ${tags.map((t) => `#${t}`).join(" ")}.` : "";
  return JSON.stringify({
    model,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
          { type: "text", text: `TODAY is ${wd} ${today}. The image is ${size.width} × ${size.height} pixels.${known}` },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "low" },
  });
}

export interface PhoneEvent {
  title: string;
  /** ISO instants (with the phone's time zone). */
  start: string;
  end: string;
}

/** A task without a time: it goes to the daily note in the vault, with a due date if there is one. */
export interface PhoneTodo {
  title: string;
  /** YYYY-MM-DD or "". */
  date: string;
}

const hhmm = (s: string): [number, number] | null => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]),
    mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
};

/** A task ticked on paper: it is marked done in the vault and in the calendar. */
export interface PhoneTick {
  title: string;
  /** "HH:MM" or "". */
  time: string;
}

/** Tasks from the model's answer (the raw Messages API body). Wrong or incomplete entries are dropped. */
export function parseTasks(body: string, writtenAt: number): { events: PhoneEvent[]; todos: PhoneTodo[]; ticks: PhoneTick[] } {
  const json = JSON.parse(body);
  const text = (json?.content ?? [])
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
  const parsed = JSON.parse(text);
  const list = (parsed?.tasks ?? parsed?.events ?? []) as { title?: string; start?: string; end?: string; date?: string; done?: boolean }[];
  const events: PhoneEvent[] = [];
  const todos: PhoneTodo[] = [];
  const ticks: PhoneTick[] = [];
  for (const e of list) {
    const title = String(e?.title ?? "").trim();
    // un frammento (una lettera letta come attività) non è un'attività
    if ((title.match(/\p{L}/gu) ?? []).length < 3) continue;
    // ticked: the task (already in the vault / calendar) is done
    if (e?.done === true) {
      const t = hhmm(e?.start ?? "");
      ticks.push({ title, time: t ? `${String(t[0]).padStart(2, "0")}:${String(t[1]).padStart(2, "0")}` : "" });
      continue;
    }
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(String(e?.date ?? "")) ? String(e.date) : "";
    const st = hhmm(e?.start ?? "");
    if (!st) {
      todos.push({ title, date: dated });
      continue;
    }
    const day = dated || localDay(writtenAt);
    const [Y, M, D] = day.split("-").map(Number);
    const start = new Date(Y, M - 1, D, st[0], st[1]);
    const en = hhmm(e?.end ?? "");
    const end = en ? new Date(Y, M - 1, D, en[0], en[1]) : null;
    events.push({ title, start: start.toISOString(), end: end && end > start ? end.toISOString() : "" });
  }
  return { events, todos, ticks };
}

/** A "task" that is only one of the author's tags ("#taccuino" read as a box + "taccuino"): not a task. */
export function isOnlyTag(title: string, tags: string[]): boolean {
  const t = title.trim().replace(/^#/, "").toLowerCase();
  if (!t || /\s/.test(t)) return false;
  const plain = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return tags.some((tag) => plain(tag) === plain(t));
}
