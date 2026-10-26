// The calendar follows the notes, like the Obsidian plugin did with Google Calendar: the tasks with a time written
// with the pen live in the notes (blocks <!-- neopen:testo:… -->, written by the plugin, on the PC or on the phone).
// When one of them disappears from the notes (struck through on the paper, or deleted in Obsidian) its calendar event
// goes; when its date or time changes (old time struck through and the new one written beside it) the event moves.
import { looseTitle, sameTitle } from "./similar";
import { VaultTask } from "./tasks";

export interface PenTimed {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  end: string | null;
  file: string;
}

export type FollowChange =
  | { kind: "delete"; title: string; date: string; time: string }
  | { kind: "move"; title: string; date: string; time: string; to: { title: string; date: string; time: string; end: string | null } };

const BLOCK = /^<!--\s*(\/?)neopen:testo:([^\s>]+)\s*-->\s*$/;

/** Tasks with a date and a time inside the pen's blocks (copies in the plugin's folders, e.g. _cestino, left out). */
export function penTimedTasks(files: { path: string; text: string }[], tasks: VaultTask[]): PenTimed[] {
  const inBlock = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.path.split("/").some((part) => part.startsWith("_"))) continue;
    if (!f.text.includes("neopen:testo:")) continue;
    const lines = f.text.split("\n");
    const set = new Set<number>();
    let open = "";
    lines.forEach((l, i) => {
      const m = BLOCK.exec(l.trim());
      if (m) open = m[1] ? "" : m[2];
      else if (open) set.add(i);
    });
    if (set.size) inBlock.set(f.path, set);
  }
  const seen = new Set<string>();
  const out: PenTimed[] = [];
  for (const t of tasks) {
    if (!t.date || !t.time || t.recurrence) continue;
    if (!inBlock.get(t.file)?.has(t.line)) continue;
    const k = keyOf(t.title, t.date, t.time);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ title: t.title, date: t.date, time: t.time, end: t.end, file: t.file });
  }
  return out;
}

const keyOf = (title: string, date: string, time: string) => `${looseTitle(title)}|${date}|${time}`;

/**
 * What changed between two readings of the notes. A task that disappeared and came back with the same title and a
 * different date/time has moved; one that disappeared for good is deleted. Too many deletions at once (the vault
 * read only in part, a sync in progress) are not trusted: nothing is deleted then.
 */
export function diffPenTimed(before: PenTimed[], after: PenTimed[], maxDeletes = 6): FollowChange[] {
  if (before.length && !after.length) return [];
  const beforeKeys = new Set(before.map((b) => keyOf(b.title, b.date, b.time)));
  const afterKeys = new Set(after.map((a) => keyOf(a.title, a.date, a.time)));
  const fresh = after.filter((a) => !beforeKeys.has(keyOf(a.title, a.date, a.time)));
  const used = new Set<PenTimed>();
  const moves: FollowChange[] = [];
  const deletes: FollowChange[] = [];
  for (const b of before) {
    if (afterKeys.has(keyOf(b.title, b.date, b.time))) continue;
    // the same task with a new date or time (the same note first)
    const cands = fresh.filter((a) => !used.has(a) && sameTitle(a.title, b.title));
    const to = cands.find((a) => a.file === b.file) ?? cands[0];
    if (to) {
      used.add(to);
      moves.push({ kind: "move", title: b.title, date: b.date, time: b.time, to: { title: to.title, date: to.date, time: to.time, end: to.end } });
    } else {
      deletes.push({ kind: "delete", title: b.title, date: b.date, time: b.time });
    }
  }
  return deletes.length > maxDeletes ? moves : [...moves, ...deletes];
}
