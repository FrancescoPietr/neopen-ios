import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTask, buildIndex, dailyDateOf, deleteTask, editTask, onDay, overdue, projects, toggleTask } from "../src/core/taskStore";

const cfg = { folder: "Daily", format: "YYYY-MM-DD" };
const files = [
  { path: "Daily/2026-10-22.md", text: "### Attività\n- [ ] color video Pietro\n- [x] fare video\n" },
  { path: "Daily/2026-10-23.md", text: "- [ ] 18:00 Palestra\n" },
  { path: "Attività/Inbox.md", text: "# Inbox\n\n- [ ] comprare latte\n- [ ] dentista ⏫ 📅 2026-10-30\n\t- [ ] chiamare prima\n" },
  { path: "Templates/Task.md", text: "- [ ] modello\n" },
  { path: "Me/Video Pietro.md", text: "- [ ] montare\n" },
];

test("index, views and projects", () => {
  const ts = buildIndex(files, cfg);
  assert.equal(ts.length, 7);
  assert.equal(dailyDateOf("Daily/2026-10-22.md", cfg), "2026-10-22");
  assert.deepEqual(overdue(ts, "2026-10-23").map((t) => t.title), ["color video Pietro"]);
  assert.deepEqual(onDay(ts, "2026-10-23").map((t) => t.title), ["Palestra"]);
  assert.deepEqual(projects(ts).map((p) => [p.name, p.open]), [["Inbox", 3], ["Video Pietro", 1]]);
});

test("edits", () => {
  const ts = buildIndex(files, cfg);
  const inbox = files[2].text;
  const latte = ts.find((t) => t.title === "comprare latte")!;
  assert.equal(toggleTask(inbox, latte, "2026-10-23")!.split("\n")[2], "- [x] comprare latte ✅ 2026-10-23");
  assert.equal(editTask(inbox, latte, { date: "2026-10-24", priority: 1 })!.split("\n")[2], "- [ ] comprare latte 🔺 📅 2026-10-24");
  const dentista = ts.find((t) => t.title === "dentista")!;
  assert.equal(deleteTask(inbox, dentista, ts), "# Inbox\n\n- [ ] comprare latte\n");
  const added = appendTask(null, { title: "pane", date: null, time: null, end: null, recurrence: null, priority: 4, labels: ["casa"] }, "Spesa");
  assert.equal(added, "# Spesa\n\n- [ ] pane #casa\n");
  // daily-note task keeps its note date (no 📅 added) unless the date changes
  const pal = ts.find((t) => t.title === "Palestra")!;
  assert.equal(editTask(files[1].text, pal, { priority: 2 })!.split("\n")[0], "- [ ] 18:00 Palestra ⏫");
  assert.equal(editTask(files[1].text, pal, { date: "2026-10-25" })!.split("\n")[0], "- [ ] 18:00 Palestra 📅 2026-10-25");
});
