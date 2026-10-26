import assert from "node:assert/strict";
import { test } from "node:test";
import { diffPenTimed, penTimedTasks } from "../src/core/follow";
import { parseTasks } from "../src/core/tasks";

const daily = (body: string) => `# venerdì\n\n### Attività\n\n<!-- neopen:testo:3_27_746_14 -->\n${body}\n<!-- /neopen:testo:3_27_746_14 -->\n- [ ] 18:00 fuori dal blocco\n`;
const read = (text: string, path = "Daily/2026-10-23.md") =>
  penTimedTasks([{ path, text }], parseTasks(text, { path, dailyDate: "2026-10-23" }));

test("follow: only timed tasks written with the pen (inside the blocks), not the copies in _cestino", () => {
  const t = read(daily("- [ ] 11:00 dentista 📅 2026-10-24\n- [ ] comprare il pane\n- [x] 09:00 colazione"));
  assert.deepEqual(t.map((x) => `${x.title} ${x.date} ${x.time}`), ["dentista 2026-10-24 11:00", "colazione 2026-10-23 09:00"]);
  assert.deepEqual(read(daily("- [ ] 11:00 dentista"), "NeoPen/_cestino/vecchia.md"), []);
});

test("follow: struck through on paper → gone from the note → the event is deleted", () => {
  const before = read(daily("- [ ] 11:00 dentista 📅 2026-10-24\n- [ ] 13:00 mangiare"));
  const after = read(daily("- [ ] 13:00 mangiare"));
  assert.deepEqual(diffPenTimed(before, after), [{ kind: "delete", title: "dentista", date: "2026-10-24", time: "11:00" }]);
});

test("follow: new time or date written beside the struck one → the event moves", () => {
  const before = read(daily("- [ ] 11:00 dentista 📅 2026-10-24\n- [ ] 13:00 mangiare"));
  const after = read(daily("- [ ] 16:30 dentista 📅 2026-10-25\n- [ ] 13:00 mangiare"));
  assert.deepEqual(diffPenTimed(before, after), [
    { kind: "move", title: "dentista", date: "2026-10-24", time: "11:00", to: { title: "dentista", date: "2026-10-25", time: "16:30", end: null } },
  ]);
});

test("follow: ticks and a vault read only in part change nothing; a new appointment is created", () => {
  const before = read(daily("- [ ] 11:00 dentista 📅 2026-10-24"));
  assert.deepEqual(diffPenTimed(before, read(daily("- [x] 11:00 dentista 📅 2026-10-24 ✅ 2026-10-24\n- [ ] 15:00 nuova"))), [
    { kind: "create", title: "nuova", date: "2026-10-23", time: "15:00", end: null, file: "Daily/2026-10-23.md" },
  ]);
  // not in the past, not ticked
  assert.deepEqual(diffPenTimed(before, read(daily("- [ ] 11:00 dentista 📅 2026-10-24\n- [ ] 15:00 nuova\n- [x] 16:00 fatta 📅 2026-10-30")), 6, "2026-10-24"), []);
  assert.deepEqual(diffPenTimed(before, []), []);
  const many = read(daily(Array.from({ length: 8 }, (_, i) => `- [ ] 1${i}:00 cosa ${i}`).join("\n")));
  const one = read(daily("- [ ] 10:00 cosa 0"));
  assert.deepEqual(diffPenTimed(many, one), [], "8 deletions at once are not trusted");
});

test("follow: a task written before gets a time beside it → it becomes an appointment (created, not a task)", () => {
  const before = read(daily("- [ ] Andare a mangiare\n- [ ] 18:00 palestra"));
  assert.deepEqual(before.map((x) => x.title), ["palestra"]);
  const after = read(daily("- [ ] Andare a mangiare alle 12:00\n- [ ] 18:00 palestra"));
  assert.deepEqual(diffPenTimed(before, after), [
    { kind: "create", title: "Andare a mangiare", date: "2026-10-23", time: "12:00", end: null, file: "Daily/2026-10-23.md" },
  ]);
  // "andare 12:00 mangiare" (the time added in the middle of the line)
  const mid = parseTasks("- [ ] Andare 12:00 mangiare\n- [ ] guardare minuto 1:26 del video\n", { path: "x.md", dailyDate: null });
  assert.deepEqual(mid.map((t) => [t.title, t.time]), [["Andare mangiare", "12:00"], ["guardare minuto 1:26 del video", null]]);
  // then struck through on the paper: the event goes
  assert.deepEqual(diffPenTimed(after, read(daily("- [ ] 18:00 palestra"))), [{ kind: "delete", title: "Andare a mangiare", date: "2026-10-23", time: "12:00" }]);
});
