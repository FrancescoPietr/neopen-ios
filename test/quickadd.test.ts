import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuickAdd } from "../src/core/quickadd";

const T = "2026-10-23"; // venerdì

test("date, time, labels, priority", () => {
  const q = parseQuickAdd("dentista venerdì alle 15 #salute p1", T);
  assert.equal(q.title, "dentista");
  assert.equal(q.date, "2026-10-23");
  assert.equal(q.time, "15:00");
  assert.deepEqual(q.labels, ["salute"]);
  assert.equal(q.priority, 1);
});

test("ranges and duration", () => {
  const a = parseQuickAdd("riunione dalle 9 alle 10:30 domani +Lavoro", T);
  assert.deepEqual([a.title, a.date, a.time, a.end, a.project], ["riunione", "2026-10-24", "09:00", "10:30", "Lavoro"]);
  const b = parseQuickAdd("cena con Anne sabato alle 20 per 2 ore", T);
  assert.deepEqual([b.title, b.date, b.time, b.end], ["cena con Anne", "2026-10-24", "20:00", "22:00"]);
  const c = parseQuickAdd("call 14:30-15:00 lunedì", T);
  assert.deepEqual([c.title, c.date, c.time, c.end], ["call", "2026-10-26", "14:30", "15:00"]);
});

test("dates in words and numbers", () => {
  assert.equal(parseQuickAdd("regalo nonna il 3 novembre", T).date, "2026-11-03");
  assert.equal(parseQuickAdd("rinnovo 17/10", T).date, "2027-10-17");
  assert.equal(parseQuickAdd("x dopodomani", T).date, "2026-10-25");
  assert.equal(parseQuickAdd("x venerdì prossimo", T).date, "2026-10-30");
  assert.equal(parseQuickAdd("x tra 3 giorni", T).date, "2026-10-26");
  assert.equal(parseQuickAdd("comprare latte", T).date, null);
});

test("repetitions", () => {
  const a = parseQuickAdd("palestra ogni lunedì e giovedì alle 18", T);
  assert.deepEqual([a.title, a.recurrence, a.date, a.time], ["palestra", "every monday, thursday", "2026-10-26", "18:00"]);
  const b = parseQuickAdd("pagare affitto ogni mese il 1", T);
  assert.deepEqual([b.title, b.recurrence, b.date], ["pagare affitto", "every month", "2026-11-01"]);
  assert.equal(parseQuickAdd("stretching ogni giorno", T).recurrence, "every day");
  assert.equal(parseQuickAdd("backup ogni 2 settimane", T).recurrence, "every 2 weeks");
});
