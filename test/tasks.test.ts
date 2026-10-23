import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskLine, nextOccurrence, parseTaskLine, parseTasks, replaceLine, toggleLines } from "../src/core/tasks";

test("parses the plugin format and the Tasks plugin format", () => {
  const a = parseTaskLine("- [ ] 10:00 call domani 📅 2026-10-18")!;
  assert.equal(a.time, "10:00");
  assert.equal(a.date, "2026-10-18");
  assert.equal(a.text, "call domani");
  const b = parseTaskLine("\t- [x] 14:00-14:30 riunione #lavoro #Invertix ⏫ 🔁 every week 📅 2026-10-24 ✅ 2026-10-23")!;
  assert.equal(b.done, true);
  assert.equal(b.indent, 4);
  assert.equal(b.end, "14:30");
  assert.deepEqual(b.labels, ["lavoro", "invertix"]);
  assert.equal(b.title, "riunione");
  assert.equal(b.priority, 2);
  assert.equal(b.recurrence, "every week");
  assert.equal(b.doneDate, "2026-10-23");
  assert.equal(parseTaskLine("- Kaan"), null);
});

test("round trip", () => {
  const line = "- [ ] 14:00-14:30 riunione #lavoro ⏫ 🔁 every week 📅 2026-10-24";
  const p = parseTaskLine(line)!;
  assert.equal(formatTaskLine(p), line);
});

test("tasks of a daily note: date from the note, sub-tasks, code blocks ignored", () => {
  const md = "# Nota\n- [ ] palestra\n\t- [ ] stretching\n```\n- [ ] non conta\n```\n- [ ] 18:00 cena 📅 2026-10-24\n";
  const ts = parseTasks(md, { path: "Daily/2026-10-23.md", dailyDate: "2026-10-23" });
  assert.equal(ts.length, 3);
  assert.equal(ts[0].date, "2026-10-23");
  assert.equal(ts[0].dateFromNote, true);
  assert.equal(ts[1].parent, ts[0].id);
  assert.equal(ts[2].date, "2026-10-24");
  assert.equal(ts[0].project, "Diario");
  assert.equal(parseTasks("- [ ] x", { path: "Attività/Lavoro.md" })[0].project, "Lavoro");
});

test("recurrence", () => {
  assert.equal(nextOccurrence("every day", "2026-10-23"), "2026-10-24");
  assert.equal(nextOccurrence("every 2 weeks", "2026-10-23"), "2026-11-06");
  assert.equal(nextOccurrence("every month", "2026-01-31"), "2026-02-28");
  assert.equal(nextOccurrence("every monday, thursday", "2026-10-23"), "2026-10-26"); // 23/10/2026 = friday
  assert.equal(nextOccurrence("every weekday", "2026-10-23"), "2026-10-26");
});

test("ticking a recurring task adds the next one", () => {
  const t = parseTasks("- [ ] pagare affitto 🔁 every month 📅 2026-10-01", { path: "Attività/Casa.md" })[0];
  const lines = toggleLines(t, "2026-10-02");
  assert.deepEqual(lines, ["- [ ] pagare affitto 🔁 every month 📅 2026-11-01", "- [x] pagare affitto 🔁 every month 📅 2026-10-01 ✅ 2026-10-02"]);
  assert.equal(replaceLine("a\n- [ ] x\nb", 1, "- [ ] y", ["z"]), null);
  assert.equal(replaceLine("a\n- [ ] x\nb", 1, "- [ ] x", ["z"]), "a\nz\nb");
});
