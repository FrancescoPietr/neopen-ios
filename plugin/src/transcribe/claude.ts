// Trascrizione della scrittura a mano con l'API di Claude (Messages API + output JSON strutturato).

import { requestUrl } from "obsidian";

export interface TranscribedLine {
  /** "newnote": titolo con doppia sottolineatura a metà pagina → da qui inizia una nota nuova. */
  kind: "text" | "task" | "heading" | "newnote";
  text: string;
  /** Riga vuota dopo questa (fine del testo accanto a un disegno: quello che segue riparte sotto il disegno). */
  breakAfter?: boolean;
  /** Riga di testo scritta rientrata sotto un punto elenco (continuazione): nella nota resta rientrata. */
  indent?: number;
  /** Rettangolo della riga sull'immagine mandata a Claude (pixel), se l'ha dato. */
  box?: number[];
  /** Solo per i task: casella spuntata o barrata. */
  checked: boolean;
  /** Solo per i task: prende il posto di una riga messa dal telefono (^penna-…). */
  adopted?: boolean;
  /** Solo per i task: scadenza YYYY-MM-DD, stringa vuota se assente. */
  due: string;
  /** Solo per i task: orario HH:MM, stringa vuota se assente. */
  time?: string;
  /** Solo per i task: orario di fine HH:MM ("14:00 - 14:30"), stringa vuota se assente. */
  end?: string;
  /** Solo per "newnote": #tag scritto da solo subito sopra il titolo (decide il template). */
  tag?: string;
}

/** Una riga già trascritta corretta a penna (parole cancellate e riscritte sopra o accanto). */
export interface Correction {
  old_line: string;
  new_line: string;
}

export interface Transcription {
  lines: TranscribedLine[];
  /** Tag scritti a mano (#riunione…), senza il simbolo #. */
  tags: string[];
  /** La prima riga nuova prosegue l'ultima riga già trascritta (stessa riga sulla carta). */
  continues_last_line: boolean;
  /** Task GIÀ trascritti la cui casella ora è stata spuntata con inchiostro nero (testo come nel testo precedente). */
  checked_tasks: string[];
  /** Testo GIÀ trascritto che ora è stato cancellato con linee sopra (copiato dal testo precedente). */
  deleted_text: string[];
  /** Tag scritto sulla prima riga in alto della pagina (decide il tipo di nota), senza #. */
  page_tag: string;
  /** Freccia verso un numero: la nota continua su quella pagina. 0 se assente (la prima freccia, per compatibilità). */
  continues_on_page: number;
  /** Tutte le frecce: per ognuna, il titolo della parte di pagina in cui sta ("" = la parte prima di ogni titolo) e la pagina. */
  arrows: { title: string; page: number }[];
  /** Titolo scritto in cima alla pagina (sotto l'eventuale tag), "" se assente. */
  page_title: string;
  /** Righe già trascritte corrette con l'inchiostro nero. */
  corrections: Correction[];
  /** Righe già trascritte (non in cima) che ora hanno una doppia sottolineatura nera: diventano titolo di una nota nuova. */
  new_titles: string[];
  /** #tag (template) scritti accanto o subito sopra un titolo: a quale titolo appartengono. */
  title_tags: { title: string; tag: string }[];
  /** Scritte collegate con una freccia a una riga (risposta / nota su quella riga): non sono task. */
  replies: { to: string; text: string }[];
  /** Disegni (in pixel dell'immagine) con le scritte che li accompagnano; nel testo una riga "[[drawing N]]". */
  drawings: { box: number[]; labels: { text: string; box: number[]; arrow?: number[]; line_boxes?: number[][] }[]; text_side: "left" | "right" | "none"; lines_beside: number; existing: number }[];
}

/** Pagine scritte apposta per mostrare la calligrafia (#alfabeto): campioni mandati insieme a ogni pagina. */
export interface HandwritingRef {
  pngBase64: string;
}

/**
 * Lo schema delle pagine #alfabeto (lo stesso che si dà a te per scriverle): Claude sa così cosa c'è scritto
 * e può confrontare ogni segno con la lettera giusta.
 */
export { alphabetScheme } from "./samples";
import { alphabetScheme } from "./samples";

export const MODELS: Record<string, string> = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (equilibrato)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (più economico)",
  "claude-opus-5-5": "Claude Opus 5.5 (il migliore sul corsivo)",
};

// Righe come stringhe brevi (molti meno token in uscita rispetto a un oggetto per riga):
//   testo normale · "# titolo" · "[ ] task" / "[x] task" · orario "[ ] 15:00 task" · data "… @2026-10-23"
const SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
    line_boxes: { type: "array", items: { type: "array", items: { type: "number" } } },
    tags: { type: "array", items: { type: "string" } },
    continues_last_line: { type: "boolean" },
    checked_tasks: { type: "array", items: { type: "string" } },
    deleted_text: { type: "array", items: { type: "string" } },
    page_tag: { type: "string" },
    arrows: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, page: { type: "integer" } },
        required: ["title", "page"],
        additionalProperties: false,
      },
    },
    page_title: { type: "string" },
    new_titles: { type: "array", items: { type: "string" } },
    replies: {
      type: "array",
      items: {
        type: "object",
        properties: { to: { type: "string" }, text: { type: "string" } },
        required: ["to", "text"],
        additionalProperties: false,
      },
    },
    title_tags: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, tag: { type: "string" } },
        required: ["title", "tag"],
        additionalProperties: false,
      },
    },
    drawings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box: { type: "array", items: { type: "number" } },
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                box: { type: "array", items: { type: "number" } },
                line_boxes: { type: "array", items: { type: "array", items: { type: "number" } } },
                arrow: { type: "array", items: { type: "number" } },
              },
              required: ["text", "box", "line_boxes", "arrow"],
              additionalProperties: false,
            },
          },
          text_side: { type: "string", enum: ["left", "right", "none"] },
          lines_beside: { type: "integer" },
          existing: { type: "integer" },
        },
        required: ["box", "labels", "text_side", "lines_beside", "existing"],
        additionalProperties: false,
      },
    },
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: { old_line: { type: "string" }, new_line: { type: "string" } },
        required: ["old_line", "new_line"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines", "line_boxes", "tags", "continues_last_line", "checked_tasks", "deleted_text", "page_tag", "arrows", "page_title", "corrections", "new_titles", "title_tags", "replies", "drawings"],
  additionalProperties: false,
};

/**
 * Istruzioni FISSE (uguali in ogni chiamata), in inglese perché costano circa la metà dei token
 * dell'italiano: la trascrizione resta nella lingua in cui hai scritto. Vanno nel "system" con la cache.
 */
const SYSTEM_RULES = `You transcribe handwritten notebook pages captured by a smartpen. The writing is mostly Italian (sometimes other languages), often small, fast cursive. Transcribe in the language it was written in. Keep the author's words; fix only obvious illegibility; a truly illegible word becomes […].

INK: GRAY ink was already transcribed: use it only as context, never transcribe it. Transcribe only BLACK ink. If there is no gray ink, transcribe everything. RED lines are new strike-throughs measured from the pen strokes (see STRIKE-THROUGHS): never transcribe them, and never transcribe the words they cross. BLUE lines with numbered blue circles are reply arrows measured from the pen strokes (see replies): never transcribe them.

READING CURSIVE: read word by word using the sentence context and pick the reading that gives a sensible Italian sentence. In fast cursive a/o/e look alike, and so do n/m/u/r/v; final letters are often just hinted. A word repeated on the page is probably written the same way: compare. If a reading looks like a meaningless acronym (e.g. "PRVD"), re-read it as a plausible Italian word (e.g. "devo"). When unsure, prefer the author's frequent words, if given.

lines: one string per written line, in reading order (top to bottom, left to right):
- plain text: as written.
- LINE BREAKS: keep the paper's line breaks. A dash item written over two or three lines is two or three entries in lines: the first keeps its dash ("- text"), the next ones are written WITHOUT dash, as plain text. Never join the lines of one item into one string (tasks with a box are the exception, see below).
line_boxes: one entry per entry of lines, in the same order and the same count: the tight rectangle [x0, y0, x1, y1] around that line's words in PIXELS of this image (x to the right, y down), including its dash if it has one. Read the real horizontal start of each line carefully: the position of a line (e.g. a second line starting further right, under the middle of the line above) is kept in the note. Use [0,0,0,0] for "[[drawing N]]" entries.
- COLUMNS: blocks of text written side by side (two lists next to each other, a note on the left and one on the right) are read block by block: the whole left block from top to bottom, then the next block. Never interleave lines of different blocks; a list item belongs to the block it is written in.
- UNDERLINE vs STRIKE-THROUGH: a line drawn BELOW the words (under the bottom of the letters, touching at most the descenders like g, p) is an UNDERLINE: it never deletes anything. A strike-through crosses the MIDDLE of the letters. Two parallel lines below the words = double underline. A single short line under one word (e.g. "Hey!") is an underline.
- UNDERLINES: a word or line underlined ONCE is emphasis: wrap the underlined words in **double asterisks** (bold). A line underlined TWICE (two parallel lines under it) is a TITLE that starts a NEW NOTE: at the top of the page it goes in page_title; anywhere else write it as "== " + title (e.g. "== Riunione con Marco").
- TITLE TAGS: a #tag written NEXT TO a twice-underlined title (same line, before or after it) or just ABOVE it is that note's template, even when it is squeezed very close to the end of the text above. It belongs to the title BELOW or BESIDE it, never to the text above it. Append it to the title line ("== Riunione con Marco #riunione"), or put it in page_tag for the page title. Never write it as a line of its own, and never at the end of another line.
- heading: a line written all in CAPITALS, standing alone like a section header (not underlined): "# " + text.
- task = line starting with a hand-drawn box: "[ ] text", or "[x] text" if the box is ticked or crossed. Do not write the box itself. Time in the task ("alle 15", "15:30", "ore 9"): "[ ] 15:00 text", with the time removed from the text. Time range ("14:00 - 14:30", "dalle 9 alle 11", "alle 9 fino alle 11"): "[ ] 09:00-11:00 text", with the range removed from the text. Date or day in the task ("domani", "venerdì", "17/10"): keep it in the text and append " @YYYY-MM-DD", computed from today's date.
- a task can continue on the next lines: a line WITHOUT a box that starts indented, aligned with the text of the task above (the box space on the left left empty), is part of that task. Join it into the same task string (one entry in lines), with its time/date if it contains one. If the first black line continues the last GRAY task this way, set continues_last_line true.
continues_last_line: true if the first black text is on the SAME line as the last gray line and continues it (transcribe only the black part, e.g. ", funziona bene"), or, when you are given the end of the previous page, if the first line continues the sentence left unfinished there. Otherwise false.

HAND-WRITTEN "#": two horizontal strokes crossed by two vertical or slanted strokes that STICK OUT past the crossings, like a grid, attached to the next word ("#Inventix"). Written fast it can look like ※, ✳, a starred X or a small scribble: still a "#". Never drop a #tag: if you are unsure, still write it (the author's known tags are listed below the image). A task BOX is a closed square (at most a tick or X inside that does not stick out), followed by a space and an action. At the top of the page a single word preceded by this sign is almost always a #tag, not a task.
tags: every other #word written in black anywhere (no #, lowercase). Keep them in the text too.

page_tag and page_title only when the image includes the top of the page; otherwise "".
page_tag: if the FIRST line at the top is a #tag on its own, in black: write it here (no #, lowercase) and do NOT put that line in lines (even if the tag is repeated). The page tag must never appear in lines. Otherwise "".
page_title: the first line at the top of the page (just below the tag line, if any) when it is underlined TWICE. Write it here as is (no "#", no "**") and NOT in lines. If that line is GRAY (already transcribed) and now has a BLACK double underline, it has become the title: copy its text exactly from the already transcribed text. A line underlined only once is NOT a title (it is bold text). Never invent a title. Otherwise "".
title_tags: a BLACK #tag written next to or just above a title (see TITLE TAGS): {title: that title's text, tag: the tag without #, lowercase}. Use it for every such tag, both for new black titles and for GRAY titles already transcribed (the page's known titles are listed below the image). Otherwise [].
new_titles: GRAY lines below the top that now have a BLACK double underline: copy each exactly from the already transcribed text (they become titles of new notes). A black single underline under gray words is bold: use corrections (same line with ** around the words). Otherwise [].
replies: a line or curved arrow drawn FROM a written line (often starting at its box or tick) TO other writing below or beside it means that writing is a REPLY / NOTE about that line, never a new task, even if the arrow's tip looks like a box. For each: {to: the line the arrow starts from (copied exactly as you wrote it in lines, or from the already transcribed text if it is gray), text: the reply}. Do not write the reply in lines. The line the arrow starts from keeps its own box: if there is a tick or X in that box (even touching the arrow's start), it is "[x]". Otherwise [].
arrows: every arrow (→, ->, ⟶) pointing to a page number (e.g. "→ 7", "→ pag. 7") means "this part continues on that page". For each arrow write {title, page}: title = the twice-underlined title of the part of the page the arrow is in (the nearest one above it: a "== " title, or page_title), or "" if the arrow comes before any title. Do not transcribe the arrows or the numbers. Otherwise [].
checked_tasks: a black tick or X inside (or across) a GRAY box (an already transcribed task): do not add a line; write that task's text copied exactly from the already transcribed text. Find the task on the SAME line as the box with the tick, reading to the right of the box; gray lines struck through above or below it are deleted text: ignore them, they never change which task is checked. Even a small or quick tick counts. Otherwise [].
STRIKE-THROUGHS: one or more lines (straight, diagonal, zig-zag or dense hatching) drawn ACROSS the words cancel them (lines entirely below the words are underlines, see above). Lines drawn in RED were measured from the pen strokes: they are ALWAYS strike-throughs, never ticks or underlines. A task whose words are struck through is deleted entirely (box, time and date included), even if the strike line starts at or before its box. Diagonal lines running across several lines of text delete all of those lines. Black strike lines over GRAY words: put those words in deleted_text, copied exactly from the already transcribed text (one entry per line or piece of line); add no lines for them. Black words struck through in black: simply do not transcribe them. Lines over drawings do not count. Otherwise [].
CORRECTIONS: words struck through with a replacement written above, beside or right after them mean "replace". In black text, transcribe the replacement in place of the struck words (e.g. "nuoto alle 15:00" with 15:00 struck and 16:00 written next to it → "[ ] 16:00 nuoto"). When black ink corrects an already transcribed GRAY line (gray words struck through in black + black replacement), add to corrections {old_line: that whole line copied exactly from the already transcribed text, new_line: the whole corrected line in the lines format (with box, time, @date)}; then do not put those words in deleted_text nor the replacement in lines. Otherwise corrections is [].
A TICK or X that starts inside or at a task box (a short V or X shape) is a CHECK, never a strike-through: the task goes in checked_tasks (or "[x]"), never in deleted_text. A RED line is never a tick. When in doubt about a BLACK line, do not delete.
DRAWINGS: a BLACK sketch, diagram, logo, shape or picture (not letters) is a drawing. For each one, in order from top to bottom: {box: [x0, y0, x1, y1] = the rectangle around the drawing itself, in PIXELS of this image (x to the right, y down, origin top-left; the image size is given below), labels: everything written around or inside the drawing that belongs to it: names, #tags beside it, and EVERY note joined to the drawing by an arrow or a line, even a note of several lines or a list. Give each note (or name, or tag) as ONE label {text: exactly as written, with a line break "\\n" wherever the paper has a new line (keep "#" for tags and list dashes like "- boxy"), box: the rectangle around the WORDS of the note only, in pixels, line_boxes: one tight rectangle per line of the note, in the same order as its lines (one for a one-line label), arrow: the rectangle around the arrow or line joining it to the drawing (from its tail to its tip), [] if there is none}. Notes written side by side are separate labels: never mix their lines (follow each arrow to its own note). Arrows or lines joining a note to the drawing are part of the drawing: never transcribe them. Do NOT write the labels in lines (a #tag label also goes in tags). In lines, write "[[drawing N]]" (N = 1, 2… in the same order) at the drawing's place in reading order. LAYOUT: if lines of text are written BESIDE the drawing (to its right or left, at the same height as the drawing), put "[[drawing N]]" immediately BEFORE the first of those lines, set text_side to the side where that text is ("right" if the text is to the right of the drawing) and lines_beside to how many entries of lines are beside it (keep the paper's line breaks); text above or below the drawing is not beside it, and notes joined to the drawing by an arrow are labels, not beside text. Otherwise text_side "none" and lines_beside 0. existing: 0 for a new drawing (see EXISTING DRAWINGS if listed). Dots, ticks, boxes, underlines and strike-throughs are not drawings. No drawings: [].
Ignore doodles and arrows that are not text or drawings. If there is no text to transcribe, lines is [].`;

/** Parte VARIABILE della richiesta (data, situazione, testo già trascritto). */
function buildUserText(
  today: string,
  hasContext: boolean,
  previousText: string,
  vocabulary: string,
  includesTop: boolean,
  previousPageText: string,
  lineHint = "",
  titles: string[] = [],
  knownTags: string[] = [],
  blacklist = ""
): string {
  const parts = [
    `Today is ${today}.`,
    includesTop
      ? "The image includes the TOP of the page."
      : "The image is only a middle or lower part of the page: page_tag and page_title must be empty.",
    hasContext ? "There is GRAY ink (already transcribed): transcribe only the BLACK ink." : "No gray ink: transcribe everything.",
  ];
  if (previousText.trim()) {
    parts.push(`Already transcribed text (the gray ink), for reference only:\n"""\n${previousText.trim()}\n"""`);
  }
  if (previousPageText.trim()) {
    parts.push(`This page CONTINUES the previous notebook page, which ends with:\n"""\n${previousPageText.trim()}\n"""`);
  }
  if (titles.length)
    parts.push(
      hasContext
        ? `Titles already on this page (gray): ${titles.map((t) => `"${t}"`).join(", ")}.`
        : `Titles of this page as confirmed by the author (if a handwritten title looks like one of these, write it exactly like this): ${titles.map((t) => `"${t}"`).join(", ")}.`
    );
  if (knownTags.length)
    parts.push(
      `The author's tags (each chooses a note type): ${knownTags.map((t) => `#${t}`).join(" ")}. One of these words written alone on a line, or next to a title, is that #tag even if the "#" is unclear: keep it as #tag.`
    );
  if (vocabulary.trim()) parts.push(`Author's frequent words: ${vocabulary.trim()}`);
  if (blacklist.trim())
    parts.push(
      `Wrong readings to NEVER write (the author's handwriting makes them look likely, e.g. a "d" with a detached stem looks like "ol"): ${blacklist.trim()}. If you read one of these, re-read it as the most plausible word (often one of the frequent words).`
    );
  if (lineHint) parts.push(lineHint);
  return parts.join("\n\n");
}

/** Converte una riga compatta ("[ ] 15:00 Chiamare Marco @2026-10-23", "# Titolo"…) nel formato interno. */
/**
 * Orario dentro il testo di un'attività: "alle 12", "alle 12:00", "ore 9.30", "h 18", "dalle 9 alle 11", oppure
 * "12:00" in fondo alla riga. Restituisce l'orario (HH:MM), la fine se c'è e il testo senza.
 */
export function timeInText(s: string): { time: string; end: string; rest: string } | null {
  const ok = (h: string, m = "00") => Number(h) < 24 && Number(m) < 60;
  const fmt = (h: string, m = "00") => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const word = /(?:^|\s)(?:dalle|alle|ore|h\.?)\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:-|–|alle|fino alle)\s*(\d{1,2})(?:[:.](\d{2}))?)?(?=$|[\s,.;:!?)])/i.exec(s);
  const tail = /(?:^|\s)(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*(\d{1,2})[:.](\d{2}))?\s*$/.exec(s);
  // un orario hh:mm in mezzo alla riga ("andare 12:00 a mangiare")
  const mid = /(?:^|\s)(\d{1,2}):(\d{2})(?=$|[\s,;!?)])/.exec(s);
  const m = word ?? tail ?? mid;
  if (!m || !ok(m[1], m[2])) return null;
  // "minuto 1:26", "secondo 0:35", "pagina 2:10": non sono orari
  if (m !== word && /(?:minut[oi]|min|second[oi]|sec|pagin[ae]|pag|capitol[oi]|cap)\.?\s*$/i.test(s.slice(0, m.index))) return null;
  const end = m[3] !== undefined && ok(m[3], m[4]) ? fmt(m[3], m[4]) : "";
  const rest = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  if (!rest) return null;
  return { time: fmt(m[1], m[2]), end, rest };
}

export function parseLine(raw: unknown): TranscribedLine {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const kind = o.kind === "task" || o.kind === "heading" ? o.kind : "text";
    return { kind, text: String(o.text ?? ""), checked: !!o.checked, due: String(o.due ?? ""), time: String(o.time ?? "") };
  }
  let s = String(raw ?? "").trim();
  const box = /^\[([ xX✓✔]?)\]\s*/.exec(s);
  if (box) {
    s = s.slice(box[0].length);
    let time = "";
    let end = "";
    const tm = /^(\d{1,2})[:.](\d{2})(?:\s*[-–]\s*(\d{1,2})[:.](\d{2}))?(?=\s|$)\s*/.exec(s);
    const okT = (h?: string, m?: string) => h !== undefined && Number(h) < 24 && Number(m) < 60;
    if (tm && okT(tm[1], tm[2])) {
      time = `${tm[1].padStart(2, "0")}:${tm[2]}`;
      if (okT(tm[3], tm[4])) end = `${tm[3].padStart(2, "0")}:${tm[4]}`;
      s = s.slice(tm[0].length);
    }
    // l'orario scritto dentro il testo ("andare a mangiare alle 12:00", "dentista ore 15", "palestra 18:30"):
    // è l'orario dell'attività (diventa un appuntamento), non parte del titolo
    if (!time) {
      const at = timeInText(s);
      if (at) {
        time = at.time;
        end = at.end;
        s = at.rest;
      }
    }
    let due = "";
    const dm = /\s*@(\d{4}-\d{2}-\d{2})\s*$/.exec(s);
    if (dm) {
      due = dm[1];
      s = s.slice(0, dm.index);
    }
    return { kind: "task", text: s.trim(), checked: box[1].trim() !== "", due, time, end };
  }
  const nn = /^==+\s*(.+?)\s*$/.exec(s);
  if (nn) {
    let title = nn[1].replace(/\s*=+$/, "").replace(/\*\*/g, "").trim();
    let tag = "";
    const tm = /\s+#([\p{L}\p{N}_\-/]+)$/u.exec(title);
    if (tm) {
      tag = tm[1].toLowerCase();
      title = title.slice(0, tm.index).trim();
    }
    return { kind: "newnote", text: title, checked: false, due: "", time: "", tag };
  }
  const h = /^#{1,6}\s+(.+)$/.exec(s);
  if (h) return { kind: "heading", text: h[1].trim(), checked: false, due: "", time: "" };
  return { kind: "text", text: s, checked: false, due: "", time: "" };
}

/** Prezzi in dollari per milione di token (stima per il costo mostrato nel registro). */
const PRICES: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.4 },
};

export type Quality = "economica" | "bilanciata" | "massima";

export const QUALITIES: Record<Quality, string> = {
  economica: "Economica: risposta diretta, senza ragionamento (consigliata)",
  bilanciata: "Bilanciata: un po' di ragionamento sui casi difficili",
  massima: "Massima: ragionamento completo (costa di più)",
};

/** Impostazioni di "ragionamento" per modello e livello di qualità. */
function thinkingConfig(model: string, quality: Quality): { effort: string; thinking?: Record<string, string> } {
  if (quality === "massima") return { effort: "high" };
  if (quality === "bilanciata") return { effort: "medium" };
  // economica: niente ragionamento iniziale (il modo per disattivarlo cambia da modello a modello)
  if (model.includes("haiku")) return { effort: "low", thinking: { type: "disabled" } };
  if (model.includes("sonnet")) return { effort: "low", thinking: { type: "between_tools" } };
  return { effort: "low" };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Costo stimato in dollari. */
  cost: number;
}

export function estimateCost(model: string, u: Omit<Usage, "cost">): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return (
    (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

export async function transcribeWithClaude(opts: {
  apiKey: string;
  /** Indirizzo base del servizio (vuoto = api.anthropic.com). */
  apiBaseUrl?: string;
  model: string;
  pngBase64: string;
  hasContext: boolean;
  today: string;
  previousText?: string;
  vocabulary?: string;
  includesTop?: boolean;
  previousPageText?: string;
  quality?: Quality;
  /** Indizio dalla geometria dei tratti (es. "le linee nuove stanno sotto le parole"). */
  lineHint?: string;
  /** Titoli già trascritti delle parti della pagina. */
  titles?: string[];
  /** Tag con una regola o un template (per riconoscerli anche con un "#" poco chiaro). */
  knownTags?: string[];
  /** Letture sbagliate da non usare mai. */
  blacklist?: string;
  /** Dimensione dell'immagine in pixel (per i rettangoli dei disegni). */
  imageSize?: { width: number; height: number };
  /** Pagine #alfabeto: esempi della calligrafia dell'autore. */
  references?: HandwritingRef[];
  /** Lo schema delle pagine campione (con le frasi della lingua di chi scrive). */
  scheme?: string;
}): Promise<Transcription & { usage: Usage; raw: string; userText: string }> {
  const tc = thinkingConfig(opts.model, opts.quality ?? "economica");
  let userText = "";
  // campioni della calligrafia: sempre uguali, quindi stanno in cache insieme alle istruzioni (costano poco)
  const refs = opts.references ?? [];
  const refBlocks: Record<string, unknown>[] = refs.length
    ? [
        {
          type: "text",
          text: `HANDWRITING SAMPLES (do not transcribe them): ${refs.length === 1 ? "the next image is a page" : `the next ${refs.length} images are pages`} the author wrote to show how they write each letter. Use them to read the author's letters, especially cursive.\n${opts.scheme ?? alphabetScheme("it")}`,
        },
        ...refs.map((r, i) => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: r.pngBase64 },
          ...(i === refs.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
        })),
        { type: "text", text: "PAGE TO TRANSCRIBE:" },
      ]
    : [];
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: 4000,
    system: [{ type: "text", text: SYSTEM_RULES, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          ...refBlocks,
          { type: "image", source: { type: "base64", media_type: "image/png", data: opts.pngBase64 } },
          {
            type: "text",
            text: (userText = buildUserText(
              opts.today,
              opts.hasContext,
              opts.hasContext ? opts.previousText ?? "" : "",
              opts.vocabulary ?? "",
              opts.includesTop ?? true,
              opts.previousPageText ?? "",
              opts.lineHint ?? "",
              opts.titles ?? [],
              opts.knownTags ?? [],
              opts.blacklist ?? ""
            ) + (opts.imageSize ? `\n\nThe image is ${opts.imageSize.width} × ${opts.imageSize.height} pixels.` : "")),
          },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: tc.effort },
  };
  if (tc.thinking) body.thinking = tc.thinking;

  const send = (b: Record<string, unknown>) =>
    requestUrl({
      url: `${(opts.apiBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
      method: "POST",
      contentType: "application/json",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(b),
      throw: false,
    });

  let res = await send(body);
  // paracadute: se il modello non accetta le impostazioni di ragionamento, riprova senza
  if (res.status === 400 && /thinking|effort/i.test(String(res.text ?? ""))) {
    const plain = { ...body, output_config: { format: { type: "json_schema", schema: SCHEMA } } };
    delete (plain as Record<string, unknown>).thinking;
    res = await send(plain);
  }

  if (res.status >= 400) {
    let detail = "";
    try {
      detail = res.json?.error?.message ?? res.text;
    } catch {
      detail = res.text;
    }
    if (res.status === 401) throw new Error("Chiave API di Claude non valida.");
    throw new Error(`API Claude ${res.status}: ${String(detail).slice(0, 300)}`);
  }

  const data = res.json;
  if (data?.stop_reason === "refusal") throw new Error("Il modello ha rifiutato la richiesta.");
  const textBlock = (data?.content ?? []).find((c: any) => c.type === "text");
  if (!textBlock?.text) throw new Error("Risposta vuota dall'API.");
  const parsed = JSON.parse(textBlock.text) as Transcription;
  const u = data?.usage ?? {};
  const base = {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
  };
  return {
    usage: { ...base, cost: estimateCost(opts.model, base) },
    raw: textBlock.text,
    userText,
    lines: ((parsed.lines ?? []) as unknown[]).map((raw, i) => {
      const l = parseLine(raw);
      const b = Array.isArray((parsed as any).line_boxes?.[i]) ? (parsed as any).line_boxes[i].map(Number) : [];
      if (b.length === 4 && b.every((v: number) => Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1]) l.box = b;
      return l;
    }),
    tags: parsed.tags ?? [],
    continues_last_line: !!parsed.continues_last_line,
    checked_tasks: parsed.checked_tasks ?? [],
    deleted_text: parsed.deleted_text ?? [],
    page_tag: String(parsed.page_tag ?? "").replace(/^#/, "").trim().toLowerCase(),
    page_title: String(parsed.page_title ?? "").trim(),
    corrections: (Array.isArray(parsed.corrections) ? parsed.corrections : [])
      .map((c) => ({ old_line: String(c?.old_line ?? "").trim(), new_line: String(c?.new_line ?? "").trim() }))
      .filter((c) => c.old_line && c.new_line),
    new_titles: (Array.isArray(parsed.new_titles) ? parsed.new_titles : []).map((t) => String(t ?? "").trim()).filter(Boolean),
    replies: (Array.isArray(parsed.replies) ? parsed.replies : [])
      .map((r) => ({ to: String(r?.to ?? "").trim(), text: String(r?.text ?? "").trim() }))
      .filter((r) => r.to && r.text),
    title_tags: (Array.isArray(parsed.title_tags) ? parsed.title_tags : [])
      .map((t) => ({ title: String(t?.title ?? "").trim(), tag: String(t?.tag ?? "").replace(/^#/, "").trim().toLowerCase() }))
      .filter((t) => t.title && t.tag),
    drawings: (Array.isArray(parsed.drawings) ? parsed.drawings : [])
      .map((d: any) => ({
        box: Array.isArray(d?.box) ? d.box.map(Number) : [],
        labels: (Array.isArray(d?.labels) ? d.labels : []).map((l: any) => ({
          text: String(l?.text ?? "").trim(),
          box: Array.isArray(l?.box) ? l.box.map(Number) : [],
          arrow: Array.isArray(l?.arrow) ? l.arrow.map(Number) : [],
          line_boxes: Array.isArray(l?.line_boxes) ? l.line_boxes.filter((b: any) => Array.isArray(b) && b.length === 4).map((b: any[]) => b.map(Number)) : [],
        })),
        text_side: d?.text_side === "left" || d?.text_side === "right" ? d.text_side : "none",
        lines_beside: Math.max(0, Math.min(40, Math.round(Number(d?.lines_beside) || 0))),
        existing: Math.max(0, Math.round(Number(d?.existing) || 0)),
      }))
      .filter((d: { box: number[] }) => d.box.length === 4),
    arrows: arrowsOf(parsed),
    continues_on_page: arrowsOf(parsed)[0]?.page ?? 0,
  };
}

/** Frecce verso altre pagine (anche dal vecchio campo continues_on_page). */
function arrowsOf(parsed: any): { title: string; page: number }[] {
  const list = Array.isArray(parsed?.arrows) ? parsed.arrows : [];
  const out = list
    .map((a: any) => ({ title: String(a?.title ?? "").trim(), page: Math.floor(Number(a?.page)) }))
    .filter((a: { page: number }) => a.page > 0);
  if (!out.length && Number(parsed?.continues_on_page) > 0) out.push({ title: "", page: Math.floor(Number(parsed.continues_on_page)) });
  return out;
}

/**
 * Una spunta misurata dai tratti su una casella: quale task è? L'immagine è solo quella riga (la scritta in grigio,
 * la spunta in nero); Claude sceglie tra i task ancora da fare della pagina. "" se nessuno corrisponde.
 */
export async function readTickedTask(opts: {
  apiKey: string;
  apiBaseUrl?: string;
  model: string;
  pngBase64: string;
  candidates: string[];
}): Promise<{ task: string; cost: number }> {
  const list = opts.candidates.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const body = {
    model: opts.model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: opts.pngBase64 } },
          {
            type: "text",
            text:
              "This image is one line of a handwritten page: a task box with the task text after it, in GRAY (already transcribed), and a new BLACK tick or X on the box. " +
              "Which of these tasks is the one written on this line? Read the gray handwriting after the box and choose the task that best matches it. " +
              "The task text was transcribed earlier and can differ from the handwriting: misread words, words missing (e.g. struck-through words or a time left out), a time or date added. Match on the words that are there.\n" +
              list +
              '\nAnswer with its number in "n" (0 only if none of them can be this line).',
          },
        ],
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
      },
    },
  };
  const res = await requestUrl({
    url: `${(opts.apiBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
    method: "POST",
    contentType: "application/json",
    headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`API Claude ${res.status}`);
  const data = res.json;
  const text = (data?.content ?? []).find((c: any) => c.type === "text")?.text ?? "{}";
  const n = Number(JSON.parse(text).n) || 0;
  const u = data?.usage ?? {};
  const cost = estimateCost(opts.model, {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
  });
  return { task: n >= 1 && n <= opts.candidates.length ? opts.candidates[n - 1] : "", cost };
}
