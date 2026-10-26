// Funzioni pure per scrivere la trascrizione nella nota senza toccare il resto.
// Ogni pagina del quaderno ha il suo blocco, identificato dall'id della pagina:
//   <!-- neopen:testo:3_27_746_4 -->
//   ...
//   <!-- /neopen:testo:3_27_746_4 -->
// Così una nota può contenere più pagine (continuazioni) e la nota del giorno le task di più pagine.
// I blocchi senza id delle versioni 0.2.x continuano a funzionare.

import { TranscribedLine } from "./claude";

export const BLOCK_START = "<!-- neopen:testo -->";
export const BLOCK_END = "<!-- /neopen:testo -->";
const OLD_PLACEHOLDER = "<!-- La trascrizione automatica arriverà nella fase 3 del plugin. -->";

export function blockStart(id?: string): string {
  return id ? `<!-- neopen:testo:${id} -->` : BLOCK_START;
}
export function blockEnd(id?: string): string {
  return id ? `<!-- /neopen:testo:${id} -->` : BLOCK_END;
}

export function emptyBlock(id?: string): string {
  return `${blockStart(id)}\n${blockEnd(id)}`;
}

/** Posizione del contenuto del blocco: prima quello con l'id, altrimenti quello vecchio senza id. */
function locate(content: string, id?: string): { start: number; end: number } | null {
  const tries = id ? [id, undefined] : [undefined];
  for (const k of tries) {
    const s = content.indexOf(blockStart(k));
    if (s < 0) continue;
    const start = s + blockStart(k).length;
    const end = content.indexOf(blockEnd(k), start);
    if (end >= 0) return { start, end };
  }
  return null;
}

export function hasBlock(content: string, id?: string): boolean {
  return locate(content, id) !== null;
}

export function linesToMarkdown(lines: TranscribedLine[]): string {
  let inList = false;
  return lines
    .map((l) => {
      const wasList = inList;
      inList = l.kind === "text" && /^[-*•]\s/.test(l.text.trim()) ? true : l.kind === "text" && !!l.indent && wasList;
      const text = l.text.trim();
      if (!text) return "";
      if (l.kind === "task") {
        const end = /^\d{1,2}:\d{2}$/.test(l.end ?? "") ? `-${l.end!.padStart(5, "0")}` : "";
        const time = /^\d{1,2}:\d{2}$/.test(l.time ?? "") ? `${l.time!.padStart(5, "0")}${end} ` : "";
        const due = /^\d{4}-\d{2}-\d{2}$/.test(l.due) ? ` 📅 ${l.due}` : "";
        return `- [${l.checked ? "x" : " "}] ${time}${text}${due}`;
      }
      if (l.kind === "heading") return `### ${text}`;
      const out = l.indent && wasList ? `  ${"\u2002".repeat(l.indent)}${text}` : text;
      return l.breakAfter ? `${out}\n` : out;
    })
    .filter(Boolean)
    .join("\n");
}

/** Legge il testo attualmente nel blocco (per darlo a Claude come contesto). */
export function readBlock(content: string, id?: string): string {
  const loc = locate(content, id);
  return loc ? content.slice(loc.start, loc.end).trim() : "";
}

/** Attacca la prima riga nuova alla fine dell'ultima riga esistente (prima di un'eventuale data 📅). */
function joinToLastLine(inner: string, add: string): string {
  const lines = inner.split("\n");
  const [first, ...rest] = add.split("\n");
  // la riga nuova non deve ripetere il prefisso di un task o titolo
  const piece = first.replace(/^(- \[[ xX]\] |### )/, "");
  let last = lines.pop() ?? "";
  const due = last.match(/ 📅 \d{4}-\d{2}-\d{2}$/);
  if (due) last = last.slice(0, -due[0].length);
  const sep = /^[,.;:!?)]/.test(piece) ? "" : " ";
  lines.push(`${last}${sep}${piece}${due ? due[0] : ""}`);
  return [...lines, ...rest].join("\n");
}

/**
 * Inserisce `md` nel blocco della pagina.
 * - append: aggiunge in fondo al blocco, su una nuova riga (o prosegue l'ultima riga se continuesLastLine)
 * - replace: sostituisce tutto il contenuto del blocco
 * Se il blocco non c'è, lo crea: al posto del vecchio segnaposto se presente, altrimenti in fondo alla nota.
 */
export function writeIntoBlock(
  content: string,
  md: string,
  mode: "append" | "replace",
  continuesLastLine = false,
  id?: string
): string {
  let s = content;
  if (!locate(s, id)) {
    if (s.includes(OLD_PLACEHOLDER)) s = s.replace(OLD_PLACEHOLDER, emptyBlock(id));
    else s = appendBlockAfterLast(s, id);
  }
  const { start, end } = locate(s, id)!;
  const inner = s.slice(start, end).trim();
  const add = md.trim();
  let next: string;
  if (mode === "replace" || !inner) next = add;
  else if (!add) next = inner;
  else if (continuesLastLine && !add.startsWith("```")) next = joinToLastLine(inner, add);
  else next = `${inner}\n${add}`;
  return `${s.slice(0, start)}\n${next}${next ? "\n" : ""}${s.slice(end)}`;
}

function norm(t: string): string {
  return t
    .toLowerCase()
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/^\s*\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Applica `fn` alle righe del blocco della pagina. */
function mapBlockLines(content: string, id: string | undefined, fn: (lines: string[]) => string[]): string {
  const loc = locate(content, id);
  if (!loc) return content;
  const lines = content.slice(loc.start, loc.end).split("\n");
  const inner = fn(lines).join("\n").trim();
  return `${content.slice(0, loc.start)}\n${inner}${inner ? "\n" : ""}${content.slice(loc.end)}`;
}

/** Spunta (- [ ] → - [x]) i task del blocco il cui testo corrisponde. */
export function checkTasksInBlock(
  content: string,
  tasks: string[],
  id?: string,
  fuzzy = false
): { content: string; count: number; matched: string[] } {
  const wanted = tasks.map((t) => ({ raw: t, n: norm(stripPrefix(t.trim())) })).filter((w) => w.n);
  if (!wanted.length || !locate(content, id)) return { content, count: 0, matched: [] };
  let count = 0;
  const matched = new Set<string>();
  const out = mapBlockLines(content, id, (lines) => {
    const open = lines.map((line, i) => ({ i, m: line.match(/^(\s*- )\[ \] (.*)$/) })).filter((x) => x.m);
    for (const w of wanted) {
      let best: { i: number; score: number } | null = null;
      for (const { i, m } of open) {
        if (!lines[i].match(/^\s*- \[ \] /)) continue; // già spuntato in questo giro
        const t = norm(m![2]);
        let score = t === w.n ? 1 : w.n.length >= 4 && (t.startsWith(w.n) || w.n.startsWith(t)) ? 0.95 : 0;
        if (!score && fuzzy) score = similarity(t, w.n);
        if (score > (best?.score ?? 0)) best = { i, score };
      }
      // copia non perfetta (lettere sbagliate, orario in più o in meno): basta che le parole si somiglino
      if (best && best.score >= (fuzzy ? 0.5 : 0.95)) {
        lines[best.i] = lines[best.i].replace(/^(\s*- )\[ \] /, "$1[x] ");
        count++;
        matched.add(w.raw);
      }
    }
    return lines;
  });
  return { content: count ? out : content, count, matched: [...matched] };
}

/** Riga di risposta sotto una riga (freccia dalla riga alla risposta): sotto-punto rientrato "↳ …". */
export const REPLY_PREFIX = "\t- ↳ ";

/**
 * Mette la risposta subito sotto la riga indicata (dopo le eventuali risposte già presenti).
 * `found` = false se la riga non c'è in questo blocco.
 */
export function addReplyInBlock(content: string, to: string, text: string, id?: string, fuzzy = false): { content: string; found: boolean } {
  const want = norm(stripPrefix(to.trim()));
  const reply = text.trim();
  if (!want || !reply || !locate(content, id)) return { content, found: false };
  let found = false;
  const out = mapBlockLines(content, id, (lines) => {
    let best: { i: number; score: number } | null = null;
    lines.forEach((line, i) => {
      if (/^\s+- ↳ /.test(line) || !line.trim()) return;
      const t = norm(stripPrefix(line.replace(/^\s*- \[[ xX]\] /, "").replace(/^\s*- /, "")));
      let score = t === want ? 1 : want.length >= 4 && (t.startsWith(want) || want.startsWith(t)) ? 0.95 : 0;
      if (!score && fuzzy) score = similarity(t, want);
      if (score > (best?.score ?? 0)) best = { i, score };
    });
    const b = best as { i: number; score: number } | null;
    if (!b || b.score < (fuzzy ? 0.5 : 0.95)) return lines;
    found = true;
    let at = b.i + 1;
    while (at < lines.length && /^\s+- ↳ /.test(lines[at])) {
      if (norm(lines[at].replace(/^\s+- ↳ /, "")) === norm(reply)) return lines; // già presente
      at++;
    }
    lines.splice(at, 0, REPLY_PREFIX + reply);
    return lines;
  });
  return { content: found ? out : content, found };
}

/** Somiglianza tra due testi (parole in comune, con tolleranza per parole lette male). */
function similarity(a: string, b: string): number {
  const A = a.split(" ").filter(Boolean);
  const B = b.split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;
  const close = (x: string, y: string) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4))));
  let hit = 0;
  for (const x of B) if (A.some((y) => close(x, y))) hit++;
  return hit / Math.max(A.length, B.length);
}

/**
 * Toglie dal blocco il testo cancellato sulla carta.
 * - se un pezzo corrisponde a una riga intera, la riga sparisce;
 * - se corrisponde a una parte di riga, viene tolta solo quella parte;
 * - una riga che resta vuota (o solo "- [ ]") viene eliminata.
 */
export function deleteTextInBlock(content: string, pieces: string[], id?: string): { content: string; count: number } {
  const targets = pieces.map((p) => p.trim()).filter(Boolean);
  if (!targets.length || !locate(content, id)) return { content, count: 0 };
  let count = 0;
  const out = mapBlockLines(content, id, (lines) => {
    for (const target of targets) {
      const nt = norm(target);
      if (!nt) continue;
      // 1) riga intera
      let idx = lines.findIndex((l) => norm(stripPrefix(l)) === nt);
      if (idx >= 0) {
        lines.splice(idx, 1);
        count++;
        continue;
      }
      // 2) parte di riga (senza distinguere maiuscole)
      const re = new RegExp(escapeRe(target).replace(/\s+/g, "\\s+"), "i");
      idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0) {
        const cleaned = lines[idx]
          .replace(re, "")
          .replace(/\s{2,}/g, " ")
          .replace(/\s+([,.;:!?])/g, "$1")
          .replace(/[,;:]+\s*$/, "")
          .replace(/(\] |^)[,;:]\s*/, "$1")
          .trimEnd();
        if (!norm(stripPrefix(cleaned))) lines.splice(idx, 1);
        else lines[idx] = cleaned;
        count++;
      }
    }
    return lines;
  });
  return { content: count ? out : content, count };
}

/** Toglie dalla nota il blocco della pagina (marcatori compresi). */
export function removeBlock(content: string, id: string): string {
  const s = content.indexOf(blockStart(id));
  if (s < 0) return content;
  const e = content.indexOf(blockEnd(id), s);
  if (e < 0) return content;
  const before = content.slice(0, s).replace(/\n+$/, "\n");
  const after = content.slice(e + blockEnd(id).length).replace(/^\n+/, "\n");
  return before + after;
}

/**
 * Divide il blocco alla riga indicata (diventata un titolo): restituisce il contenuto senza
 * quella riga e le seguenti, il titolo (testo della riga) e le righe seguenti. null se non c'è.
 */
export function splitBlockAt(content: string, line: string, id: string): { content: string; title: string; rest: string } | null {
  const loc = locate(content, id);
  if (!loc) return null;
  const lines = content.slice(loc.start, loc.end).trim().split("\n");
  const want = normLine(line);
  const loose = norm(stripPrefix(line.trim()));
  let idx = lines.findIndex((l) => normLine(l) === want);
  if (idx < 0 && loose) idx = lines.findIndex((l) => norm(stripPrefix(l)) === loose);
  if (idx < 0) return null;
  const title = stripPrefix(lines[idx]).replace(/\*\*/g, "").trim();
  const rest = lines.slice(idx + 1).join("\n").trim();
  const keep = lines.slice(0, idx).join("\n").trim();
  return { content: `${content.slice(0, loc.start)}\n${keep}${keep ? "\n" : ""}${content.slice(loc.end)}`, title, rest };
}

/** Confronto di una riga intera, orario compreso (per le correzioni). */
function normLine(t: string): string {
  return stripPrefix(t.trim())
    .toLowerCase()
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Sostituisce una riga già trascritta con la sua versione corretta (`newMd`, già in markdown).
 * La riga si cerca prima uguale, poi "quasi uguale" (senza orario e data). Restituisce se l'ha trovata.
 */
export function replaceLineInBlock(content: string, oldLine: string, newMd: string, id?: string): { content: string; found: boolean } {
  const exact = normLine(oldLine);
  const loose = norm(stripPrefix(oldLine.trim()));
  if (!exact || !locate(content, id)) return { content, found: false };
  let found = false;
  const out = mapBlockLines(content, id, (lines) => {
    let idx = lines.findIndex((l) => normLine(l) === exact);
    if (idx < 0 && loose) idx = lines.findIndex((l) => norm(stripPrefix(l)) === loose);
    if (idx >= 0) {
      lines[idx] = newMd;
      found = true;
    }
    return lines;
  });
  return { content: found ? out : content, found };
}

function stripPrefix(l: string): string {
  return l.replace(/^\s*(- \[[ xX]\] |#{1,6} |- )/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inserisce `text` alla fine della sezione che inizia con l'intestazione `heading` (es. "## Task").
 * Se l'intestazione non c'è, la crea in fondo alla nota.
 */
export function insertUnderHeading(content: string, heading: string, text: string): string {
  const lines = content.split("\n");
  const level = (heading.match(/^#+/)?.[0].length ?? 2);
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.trim().toLowerCase());
  if (idx < 0) {
    const base = content.replace(/\s*$/, "");
    return `${base ? base + "\n\n" : ""}${heading}\n\n${text}\n`;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  // togli righe vuote finali della sezione prima di inserire
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, "", text, ...(end < lines.length ? [""] : []));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Toglie dal blocco solo le righe INTERE uguali a `text` (es. una riga diventata titolo). */
export function removeLineInBlock(content: string, text: string, id?: string): string {
  const nt = norm(text);
  if (!nt || !locate(content, id)) return content;
  let removed = false;
  const out = mapBlockLines(content, id, (lines) =>
    lines.filter((l) => {
      if (!removed && norm(stripPrefix(l)) === nt) {
        removed = true;
        return false;
      }
      return true;
    })
  );
  return removed ? out : content;
}

/**
 * Note create dalle versioni 0.3.0–0.3.3: le pagine di continuazione avevano un'intestazione
 * "### Pagina N" e un'immagine propria. Ora il testo scorre unico e l'immagine è una sola:
 * togliamo quelle intestazioni e immagini (solo se stanno subito prima del blocco di una pagina).
 */
export function stripLegacyPageSections(content: string): string {
  let out = content.replace(/\n*### Pagina \d+\n+(?:!\[\[[^\]\n]*_pagine\/[^\]\n]*\.svg\]\]\n+)?(?=<!-- neopen:testo:\d+_\d+_\d+_\d+ -->)/g, "\n");
  // un "## Testo" ripetuto subito prima del blocco di una pagina, quando c'è già un blocco prima (bug 0.4.0–0.4.2)
  const firstEnd = out.search(/<!-- \/neopen:testo(?::\d+_\d+_\d+_\d+)? -->/);
  if (firstEnd >= 0) {
    const head = out.slice(0, firstEnd);
    const tail = out.slice(firstEnd).replace(/\n+## Testo\n+(?=<!-- neopen:testo:\d+_\d+_\d+_\d+ -->)/g, "\n");
    out = head + tail;
  }
  return out;
}

/**
 * Aggiunge il blocco vuoto di una pagina: subito dopo l'ultimo blocco di pagina già presente
 * (il testo resta continuo, senza intestazioni); solo se la nota non ne ha nessuno crea "## Testo".
 */
export function appendBlockAfterLast(content: string, id?: string): string {
  const re = /<!-- \/neopen:testo(?::\d+_\d+_\d+_\d+)? -->/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(content); m; m = re.exec(content)) last = m;
  if (last) {
    const pos = last.index + last[0].length;
    return `${content.slice(0, pos)}\n${emptyBlock(id)}${content.slice(pos)}`;
  }
  return `${content.replace(/\s*$/, "")}\n\n## Testo\n\n${emptyBlock(id)}\n`;
}
