// Where new writing goes on a page already transcribed (plugin/src/transcribe/rowEdits.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { planRowEdits } from "../plugin/src/transcribe/rowEdits";

let clock = 1_790_000_000_000;
const stroke = (pts: [number, number][]) => {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(x, y, 500);
  return { t: (clock += 1000), tip: 0, color: 0, pts: out, tx: 0 as number | undefined };
};
/** A word of letters (zig-zag strokes ~1.2 high) at x, baseline row y. */
const word = (x: number, y: number, letters = 4) =>
  Array.from({ length: letters }, (_, i) => stroke([[x + i * 0.7, y + 1.2], [x + i * 0.7 + 0.3, y], [x + i * 0.7 + 0.6, y + 1.2]]));
const scribble = (x0: number, x1: number, y: number) => {
  const pts: [number, number][] = [];
  for (let x = x0, k = 0; x < x1; x += 0.3, k++) pts.push([x, k % 2 ? y - 0.2 : y + 1.4]);
  return stroke(pts);
};
const done = <T extends { tx?: number }>(a: T[]) => a.map((s) => ((s.tx = 1), s));

// three rows already transcribed: "mangia" / "lavoro alle 23:00" / "aereo domani"
const mangia = done(word(10, 45));
const lavoro = done(word(10, 47.8));
const time = done(word(20, 47.8, 3));
const aereo = done(word(10, 50.6));
const old = [...mangia, ...lavoro, ...time, ...aereo];

test("rows: writing after the last word of a row changes that row", () => {
  const add = word(14, 45, 3);
  const all = [...old, ...add];
  const e = planRowEdits(add, [], old, all);
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].row.yc - 45.6) < 0.5);
  assert.equal(e[0].added.length, 3);
});

test("rows: a strike with a correction written just above it: both go to the struck row", () => {
  const strike = scribble(19.8, 22.4, 47.8);
  const fix = word(20, 46.2, 2);
  const all = [...old, strike, ...fix];
  const e = planRowEdits([strike, ...fix], [strike], old, all);
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].row.yc - 48.4) < 0.5);
  assert.deepEqual([e[0].strikes.length, e[0].added.length], [1, 2]);
});

test("rows: a new line at the left margin below is new text, not an edit", () => {
  const strike = scribble(19.8, 22.4, 47.8);
  const fresh = word(10, 53.4);
  const all = [...old, strike, ...fresh];
  const e = planRowEdits([strike, ...fresh], [strike], old, all);
  assert.equal(e.length, 1, "only the struck row");
  assert.equal(e[0].added.length, 0);
});

test("rows: writing far away in the margin of the same height is not glued to the row", () => {
  const far = word(40, 45, 3);
  const all = [...old, ...far];
  assert.deepEqual(planRowEdits(far, [], old, all), []);
});
