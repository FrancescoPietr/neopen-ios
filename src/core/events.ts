// Appointments written with the pen go to the calendar straight from the phone (PC off, Obsidian closed).
// Only the urgent part: tasks with a TIME become calendar events. Everything else (notes, tasks without a time, ticks,
// deletions) is done by the Obsidian plugin when it transcribes the page; then it replaces these events with its own.

import { PageRecord, Stroke } from "./models";

export const EVENTS_MODEL = "claude-sonnet-5-5";

const SYSTEM = `You read a handwritten notebook page captured by a smartpen. The writing is mostly Italian, often fast cursive. The image shows ONLY what was written just now.

Find the TASKS WITH A TIME: a line that starts with a hand-drawn box (a small square, maybe ticked) followed by an action, and that contains a time ("alle 15", "15:30", "ore 9", "h 18") or a time range ("14:00 - 14:30", "dalle 9 alle 11", "alle 9 fino alle 11"). A task can continue on the next line (indented, without a box): join it.
For each one write {title, start, end, date}:
- title: the task text as written, WITHOUT the box, the time and the day words (read cursive word by word with the sentence context; keep #tags).
- start: "HH:MM" (24h; "alle 3" in the afternoon context is 15:00 only if clearly meant, otherwise as written).
- end: "HH:MM" for a range, else "".
- date: "YYYY-MM-DD" if a day is written ("oggi", "domani", "dopodomani", a weekday, "17/10"), computed from TODAY given below (a weekday means the next one, today included); else "".
Skip a task whose words are struck through. Skip tasks without a time, plain notes, lists and drawings. If there are none, events is [].`;

const SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, date: { type: "string" } },
        required: ["title", "start", "end", "date"],
        additionalProperties: false,
      },
    },
  },
  required: ["events"],
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
export function eventsRequest(pngBase64: string, size: { width: number; height: number }, writtenAt: number, model = EVENTS_MODEL): string {
  const today = localDay(writtenAt);
  const wd = WEEKDAYS[new Date(writtenAt).getDay()];
  return JSON.stringify({
    model,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
          { type: "text", text: `TODAY is ${wd} ${today}. The image is ${size.width} × ${size.height} pixels.` },
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

const hhmm = (s: string): [number, number] | null => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]),
    mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
};

/** Events from the model's answer (the raw Messages API body). Wrong or incomplete entries are dropped. */
export function parseEvents(body: string, writtenAt: number): PhoneEvent[] {
  const json = JSON.parse(body);
  const text = (json?.content ?? [])
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("");
  const list = (JSON.parse(text)?.events ?? []) as { title?: string; start?: string; end?: string; date?: string }[];
  const out: PhoneEvent[] = [];
  for (const e of list) {
    const title = String(e?.title ?? "").trim();
    const st = hhmm(e?.start ?? "");
    if (!title || !st) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(e?.date ?? "")) ? String(e.date) : localDay(writtenAt);
    const [Y, M, D] = day.split("-").map(Number);
    const start = new Date(Y, M - 1, D, st[0], st[1]);
    const en = hhmm(e?.end ?? "");
    const end = en ? new Date(Y, M - 1, D, en[0], en[1]) : null;
    out.push({ title, start: start.toISOString(), end: end && end > start ? end.toISOString() : "" });
  }
  return out;
}
