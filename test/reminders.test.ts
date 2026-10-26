import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_REMINDERS, planAlerts } from "../src/core/reminders";
import { parseTasks, formatTaskLine, toggleLines } from "../src/core/tasks";

const now = new Date(2026, 9, 26, 8, 0).getTime(); // lun 26/10 08:00
const tasks = parseTasks(
  [
    "- [ ] 18:00 Palestra",
    "- [ ] completare App",
    "- [ ] chiamare Marco ⏰ 2026-10-26 10:30 ⏰ 2026-10-27 9:00",
    "- [x] fatto ✅ 2026-10-26",
  ].join("\n"),
  { path: "Daily/2026-10-26.md", dailyDate: "2026-10-26" }
);

test("⏰ on a task line is read and written back", () => {
  const t = tasks.find((x) => x.title === "chiamare Marco")!;
  assert.deepEqual(t.reminders, ["2026-10-26 10:30", "2026-10-27 09:00"]);
  assert.equal(formatTaskLine({ ...t, done: false }, "", true), "- [ ] chiamare Marco ⏰ 2026-10-26 10:30 ⏰ 2026-10-27 09:00");
  const rec = parseTasks("- [ ] palestra 🔁 every day ⏰ 2026-10-26 07:00 📅 2026-10-26", { path: "x.md" })[0];
  assert.equal(rec.recurrence, "every day");
  assert.match(toggleLines(rec, "2026-10-26")[0], /⏰ 2026-10-27 07:00 📅 2026-10-27$/);
});

test("alerts: events before, timed tasks at the time, own times, one summary of the day", () => {
  const events = [
    { key: "e1", title: "Dentista", start: new Date(2026, 9, 26, 15, 0).getTime(), end: new Date(2026, 9, 26, 16, 0).getTime(), allDay: false },
    { key: "e2", title: "Compleanno", start: new Date(2026, 9, 27).getTime(), end: new Date(2026, 9, 28).getTime(), allDay: true },
    { key: "e3", title: "Riunione", start: new Date(2026, 9, 26, 11, 0).getTime(), end: new Date(2026, 9, 26, 12, 0).getTime(), allDay: false },
  ];
  const a = planAlerts(tasks, events, DEFAULT_REMINDERS, { e3: [60, 0] }, now);
  const at = (x: (typeof a)[number]) => new Date(x.at).toTimeString().slice(0, 5) + " " + x.title;
  assert.deepEqual(a.filter((x) => new Date(x.at).getDate() === 26).map(at), [
    "09:00 Oggi hai 1 attività",
    "10:00 Riunione",
    "10:30 chiamare Marco",
    "11:00 Riunione",
    "14:45 Dentista",
    "18:00 Palestra",
  ]);
  assert.equal(a.find((x) => x.title === "Dentista")!.body, "tra 15 min · 15:00–16:00");
  assert.ok(a.some((x) => x.title === "chiamare Marco" && new Date(x.at).getDate() === 27));
  // ids change only when the alert changes
  assert.equal(planAlerts(tasks, events, DEFAULT_REMINDERS, { e3: [60, 0] }, now)[0].id, a[0].id);
  assert.deepEqual(planAlerts(tasks, events, { ...DEFAULT_REMINDERS, on: false }, {}, now), []);
});
