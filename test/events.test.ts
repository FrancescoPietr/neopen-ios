import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsRequest, parseTasks, strokesAfter } from "../src/core/events";
import { newRecord } from "../src/core/models";

const answer = (tasks: unknown) => JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ tasks }) }] });
const at = new Date(2026, 9, 23, 10, 0).getTime(); // venerdì 23/10/2026, 10:00

test("events from the answer: date, range, defaults", () => {
  const { events: ev, todos } = parseTasks(
    answer([
      { title: "dentista", start: "15:00", end: "", date: "" },
      { title: "call Marco", start: "9:30", end: "10:15", date: "2026-10-24" },
      { title: "", start: "11:00", end: "", date: "" },
      { title: "senza ora", start: "", end: "", date: "" },
      { title: "fine prima", start: "18:00", end: "17:00", date: "" },
    ]),
    at
  );
  assert.equal(ev.length, 3);
  assert.deepEqual(todos, [{ title: "senza ora", date: "" }]);
  assert.equal(new Date(ev[0].start).getHours(), 15);
  assert.equal(new Date(ev[0].start).getDate(), 23);
  assert.equal(ev[0].end, "");
  assert.equal(new Date(ev[1].start).getDate(), 24);
  assert.equal(new Date(ev[1].end).getMinutes(), 15);
  assert.equal(ev[2].end, ""); // end before start: the script uses the default length
});

test("request carries today's date and the image", () => {
  const b = JSON.parse(eventsRequest("AAAA", { width: 10, height: 20 }, at));
  assert.match(b.messages[0].content[1].text, /venerdì 2026-10-23/);
  assert.equal(b.messages[0].content[0].source.data, "AAAA");
});

test("only strokes after the mark, ink only", () => {
  const r = newRecord({ section: 3, owner: 27, note: 746, page: 1 });
  r.strokes = [
    { t: 1, tip: 0, color: 0, pts: [1, 1, 100] },
    { t: 5, tip: 0, color: 0, pts: [1, 1, 100] },
    { t: 6, tip: 1, color: 0, pts: [1, 1, 100] },
  ];
  assert.deepEqual(strokesAfter(r, 1).map((s) => s.t), [5]);
});

test("ticked tasks are reported as done, not created", () => {
  const r = parseTasks(
    answer([
      { title: "andare alla gentita", start: "19:00", end: "", date: "", done: true },
      { title: "completare App", start: "", end: "", date: "", done: true },
      { title: "nuova", start: "", end: "", date: "", done: false },
    ]),
    at
  );
  assert.deepEqual(r.ticks, [{ title: "andare alla gentita", time: "19:00" }, { title: "completare App", time: "" }]);
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.todos, [{ title: "nuova", date: "" }]);
});

test("events: a #tag read as a task is recognised, and the author's tags go to Claude", async () => {
  const { isOnlyTag, eventsRequest } = await import("../src/core/events");
  const tags = ["task", "tasks", "taccuino", "cinema", "giochi"];
  assert.equal(isOnlyTag("taccuino", tags), true);
  assert.equal(isOnlyTag("#Taccuino", tags), true);
  assert.equal(isOnlyTag("comprare taccuino nuovo", tags), false);
  assert.equal(isOnlyTag("dentista", tags), false);
  const body = JSON.parse(eventsRequest("AAAA", { width: 10, height: 10 }, Date.now(), "m", tags));
  assert.match(body.messages[0].content[1].text, /#taccuino/);
  assert.match(body.system, /TAGS ARE NOT TASKS/);
});
