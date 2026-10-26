import assert from "node:assert/strict";
import { test } from "node:test";
import { lineProfile, normalize, simplify } from "../src/core/drawing";

const flat = (pts: [number, number][]) => pts.flatMap(([x, y]) => [x, y, 500]);

test("a drawing fits the 100 box, centered, simplified", () => {
  // a wide check mark in Ncode units
  const d = normalize([flat([[10, 20], [12, 22], [14, 24], [16, 22], [20, 18], [24, 14], [30, 8]])]);
  const pts = d.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= 9.9 && Math.max(...xs) <= 90.1);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 50) < 0.2);
  assert.ok(d[0].length < 7);
  // a dot stays a dot
  assert.equal(normalize([flat([[5, 5], [5.01, 5.01]]), flat([[5, 10], [10, 10]])])[0].length, 1);
  assert.deepEqual(simplify([[0, 0], [1, 0.01], [2, 0]], 0.5), [[0, 0], [2, 0]]);
});

test("the character of a drawn line", () => {
  const pts: [number, number][] = Array.from({ length: 50 }, (_, i) => [100 + i * 2, 50 + Math.sin(i / 8) * 1.5]);
  const p = lineProfile([flat(pts)]);
  assert.equal(p.length, 24);
  assert.ok(p.every((v) => Math.abs(v) <= 0.03));
  assert.ok(p.some((v) => Math.abs(v) > 0.003));
  // drawn right to left: same profile direction
  assert.equal(lineProfile([flat([...pts].reverse())]).length, 24);
});
