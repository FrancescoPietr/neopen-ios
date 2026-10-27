// Attività messe dal telefono (app NeoTransfer, PC spento): stanno nella nota del giorno con un id "^penna-…".
// Quando il plugin trascrive la pagina, le sue righe prendono il posto di quelle del telefono: la riga del telefono
// sparisce e, se nell'app l'avevi già spuntata, la riga trascritta nasce spuntata. Così niente doppioni.
import { App, TFile } from "obsidian";
import type { TranscribedLine } from "../transcribe/claude";
import { sameTitle } from "../transcribe/similar";

const PHONE_LINE = /^\s*[-*] \[([ xX])\] (.*?)\s+\^(penna-[A-Za-z0-9-]+)\s*$/;

/** Titolo di una riga del telefono, senza orario, date, priorità, ripetizione. */
export function phoneTitle(rest: string): string {
  return rest
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s*🔁[^📅✅]*/gu, "")
    .replace(/[🔺⏫🔼🔽]/gu, "")
    .replace(/^\d{1,2}:\d{2}(-\d{1,2}:\d{2})?\s+/, "")
    .trim();
}

/** Toglie dal testo le righe del telefono uguali ai task trascritti. Restituisce il testo nuovo e cosa ha preso. */
export function takePhoneLines(content: string, tasks: TranscribedLine[]): { content: string; taken: { task: TranscribedLine; title: string; done: boolean; due: string }[] } {
  const taken: { task: TranscribedLine; title: string; done: boolean; due: string }[] = [];
  const used = new Set<TranscribedLine>();
  const out = content.split("\n").filter((line) => {
    const m = PHONE_LINE.exec(line);
    // solo le righe del telefono ancora da fare: una già fatta è storia (un "lavorare" di ieri non è quello di oggi)
    if (!m || m[1] !== " ") return true;
    const title = phoneTitle(m[2]);
    const task = tasks.find((t) => !used.has(t) && sameTitle(t.text, title));
    if (!task) return true;
    used.add(task);
    taken.push({ task, title, done: m[1] !== " ", due: /📅\s*(\d{4}-\d{2}-\d{2})/u.exec(m[2])?.[1] ?? "" });
    return false;
  });
  return { content: taken.length ? out.join("\n").replace(/\n{3,}/g, "\n\n") : content, taken };
}

/**
 * Prima di scrivere i task di una trascrizione: le righe che il telefono aveva già messo per gli stessi task
 * (nelle note del giorno degli ultimi 30 giorni o in qualunque nota con un blocco ^penna-) si tolgono.
 */
export async function adoptPhoneTasks(app: App, lines: TranscribedLine[], log: (m: string) => void): Promise<void> {
  const tasks = lines.filter((l) => l.kind === "task" && l.text.trim());
  if (!tasks.length) return;
  const since = Date.now() - 2 * 86_400_000;
  const files = app.vault.getMarkdownFiles().filter((f) => {
    const blocks = app.metadataCache.getFileCache(f)?.blocks;
    // le note del giorno di oggi e di ieri (o cambiate da poco), non lo storico
    const day = /^(\d{4}-\d{2}-\d{2})$/.exec(f.basename)?.[1];
    if (day) return new Date(`${day}T23:59:59`).getTime() >= since;
    return !!blocks && Object.keys(blocks).some((k) => k.toLowerCase().startsWith("penna-")) && f.stat.mtime >= since;
  });
  for (const f of files) {
    const text = await app.vault.cachedRead(f);
    if (!text.includes("^penna-")) continue;
    let taken: ReturnType<typeof takePhoneLines>["taken"] = [];
    await app.vault.process(f as TFile, (c) => {
      const r = takePhoneLines(c, tasks.filter((t) => !t.adopted));
      taken = r.taken;
      return r.content;
    });
    for (const t of taken) {
      t.task.adopted = true;
      if (t.done) t.task.checked = true;
      if (!t.task.due && t.due) t.task.due = t.due;
      log(`«${t.title}» l'aveva già messa il telefono in "${f.basename}": ora è nella trascrizione della pagina${t.done ? " (spuntata come nell'app)" : ""}.`);
    }
  }
}
