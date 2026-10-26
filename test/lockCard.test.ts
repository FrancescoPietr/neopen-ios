import assert from "node:assert/strict";
import { test } from "node:test";
import { comingEvents, todayTasks } from "../src/core/lockCard";
import { parseTasks } from "../src/core/tasks";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const now = at(26, 14).getTime(); // lun 26/10 14:00
const ev = (title: string, s: Date, e: Date, allDay = false) => ({ title, start: s, end: e, allDay, color: "#123456" });

test("lock card: nearest appointment first, finished / all-day / done / far ones left out, copies once", () => {
  const list = comingEvents(
    [
      ev("Cena", at(26, 20), at(26, 22)),
      ev("Riunione", at(26, 15), at(26, 16)),
      ev("Riunione", at(26, 15), at(26, 16)), // same event in a second calendar
      ev("In corso", at(26, 13), at(26, 15)),
      ev("Finita", at(26, 9), at(26, 10)),
      ev("Ora solare", at(26, 0), at(27, 0), true),
      ev("✓ Fatta", at(26, 16), at(26, 17)),
      ev("Colazione", at(27, 9), at(27, 10)),
      ev("Lontana", at(28, 9), at(28, 10)),
    ],
    now
  );
  assert.deepEqual(
    list.map((e) => `${e.title} ${e.time}`),
    ["In corso 13:00", "Riunione 15:00", "Cena 20:00", "Colazione domani 09:00"]
  );
  assert.equal(list[1].start, at(26, 15).getTime());
});

test("lock card: done tasks disappear, they still count", () => {
  const tasks = parseTasks(
    ["- [ ] scrivere 📅 2026-10-26", "- [x] spesa 📅 2026-10-26 ✅ 2026-10-26", "- [ ] 09:00 chiamare 📅 2026-10-26", "- [ ] vecchia 📅 2026-10-20", "- [ ] domani 📅 2026-10-27"].join("\n"),
    { path: "a.md" }
  );
  const t = todayTasks(tasks, new Date(now));
  assert.deepEqual(t.open.map((x) => x.title), ["chiamare", "scrivere", "vecchia"]);
  assert.equal(t.done, 1);
  assert.equal(t.total, 4);
});
