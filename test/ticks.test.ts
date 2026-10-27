// Ticks measured from the strokes (plugin/src/transcribe/ticks.ts): boxes at the start of a line, a V or an X on them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTaskBoxes, findTicks, taskLines } from "../plugin/src/transcribe/ticks";

let clock = 1_790_000_000_000;
const stroke = (pts: [number, number][], steps = 8) => {
  const out: number[] = [];
  for (let i = 0; i < pts.length - 1; i++)
    for (let k = 0; k < steps; k++) out.push(pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * k) / steps, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * k) / steps, 500);
  out.push(pts[pts.length - 1][0], pts[pts.length - 1][1], 500);
  return { t: (clock += 1000), tip: 0, color: 0, pts: out };
};
/** A hand-drawn box (starting at a corner, a little overshoot) at x, y. */
const box = (x: number, y: number, s = 1.4) => stroke([[x + 0.1, y], [x + s, y + 0.05], [x + s, y + s], [x, y + s - 0.05], [x + 0.05, y + 0.25]]);
/** A word: a zig-zag of letters. */
const word = (x: number, y: number, n = 6) => stroke(Array.from({ length: n }, (_, i) => [x + i * 0.5, y + (i % 2 ? 0.2 : 1.2)] as [number, number]), 3);
/** An "O" at the start of a word, touching the next letter. */
const oh = (x: number, y: number) => stroke(Array.from({ length: 17 }, (_, i) => [x + 0.7 + 0.7 * Math.cos((i / 16) * 2 * Math.PI), y + 0.7 + 0.75 * Math.sin((i / 16) * 2 * Math.PI)] as [number, number]), 2);

test("ticks: boxes at the start of a line are found, an O at the start of a word is not", () => {
  const page = [box(8, 10), word(11, 10), word(15, 10), box(8, 13), word(11, 13), oh(8, 17), word(9.6, 17), word(14, 17)];
  const boxes = findTaskBoxes(page, page);
  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].y0 < boxes[1].y0);
});

test("ticks: a V or an X on a box is a tick of that box; a strike over the words is not", () => {
  const page = [box(8, 10), word(11, 10), box(8, 13), word(11, 13)];
  const boxes = findTaskBoxes(page, page);
  const v = stroke([[8.2, 13.6], [8.6, 14.3], [9.9, 12.4]]);
  assert.deepEqual(findTicks([v], boxes).map((k) => k.index), [1]);
  const x = stroke([[8.1, 10.1], [9.3, 11.3]]);
  assert.deepEqual(findTicks([x], boxes).map((k) => k.index), [0]);
  const strike = stroke([[10.8, 10.7], [16, 10.6]]);
  assert.deepEqual(findTicks([strike], boxes), []);
  const elsewhere = word(20, 20);
  assert.deepEqual(findTicks([elsewhere], boxes), []);
});

test("ticks: the tasks of the page's blocks, in order", () => {
  assert.deepEqual(taskLines(["- [ ] pane\ntesto\n- [x] latte", "\t- [ ] 12:00 cena"]), [
    { text: "pane", done: false },
    { text: "latte", done: true },
    { text: "12:00 cena", done: false },
  ]);
});
