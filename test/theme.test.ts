import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, contrast, makePalette, mix } from "../src/ui/theme/colors";
import { roughCircle, roughLine, roughRect, strokesPath } from "../src/ui/theme/rough";
import { CATALOG } from "../src/ui/theme/catalog";

test("every preset is readable", () => {
  for (const p of PRESETS) {
    const c = makePalette(p);
    assert.ok(contrast(c.ink, c.paper) >= 7, p.id);
    assert.ok(contrast(c.inkSoft, c.paper) >= 3, p.id);
  }
});

test("ink too close to the paper is pushed away", () => {
  const c = makePalette({ paper: "#F6F0E1", ink: "#F0EAD8", accent: "#D2453F" });
  assert.ok(contrast(c.ink, c.paper) >= 7);
  assert.equal(makePalette({ paper: "#16181D", ink: "#202226", accent: "#FF7A59" }).dark, true);
  assert.equal(mix("#000000", "#FFFFFF", 0.5), "#808080");
});

test("hand-drawn shapes are stable and well formed", () => {
  assert.equal(roughLine(0, 3, 300, 3, "a"), roughLine(0, 3, 300, 3, "a"));
  assert.notEqual(roughLine(0, 3, 300, 3, "a"), roughLine(0, 3, 300, 3, "b"));
  for (const d of [roughLine(0, 3, 300, 3, "a"), roughRect(200, 80, "x"), roughCircle(12, 12, 9, 9, "c")]) {
    assert.match(d, /^M[-\d.]+ [-\d.]+/);
    assert.doesNotMatch(d, /NaN|Infinity/);
  }
  for (const e of CATALOG) {
    const d = strokesPath(e.strokes, e.id, 24);
    assert.doesNotMatch(d, /NaN|Infinity/, e.id);
  }
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
});
