import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInPlace, mergeSettings } from "../plugin/src/settingsMerge";

test("settings merge: a stale copy does not erase pages written by the phone", () => {
  const base = { model: "a", pageNotes: { p1: { path: "x.md" } }, pageIndex: { p1: { done: 1 } } };
  // the PC changed only the model
  const mine = { model: "b", pageNotes: { p1: { path: "x.md" } }, pageIndex: { p1: { done: 1 } } };
  // meanwhile the phone transcribed page p2 and moved p1 forward
  const disk = { model: "a", pageNotes: { p1: { path: "x.md" }, p2: { path: "Daily/2026-11-14.md" } }, pageIndex: { p1: { done: 5 }, p2: { done: 9 } } };
  const out = mergeSettings(base, mine, disk) as any;
  assert.equal(out.model, "b");
  assert.deepEqual(out.pageNotes.p2, { path: "Daily/2026-11-14.md" });
  assert.equal(out.pageIndex.p1.done, 5);
  assert.equal(out.pageIndex.p2.done, 9);
});

test("settings merge: our own changes per page win, deletions too", () => {
  const base = { pageNotes: { p1: { path: "a.md" }, p2: { path: "b.md" } } };
  const mine = { pageNotes: { p1: { path: "renamed.md" } } };
  const disk = { pageNotes: { p1: { path: "a.md" }, p2: { path: "b.md" }, p3: { path: "c.md" } } };
  const out = mergeSettings(base, mine, disk) as any;
  assert.deepEqual(out.pageNotes, { p1: { path: "renamed.md" }, p3: { path: "c.md" } });
  // the same objects stay in place (other parts keep references)
  const target: any = { pageNotes: { p1: { path: "renamed.md" } } };
  const ref = target.pageNotes;
  applyInPlace(target, out);
  assert.equal(target.pageNotes, ref);
  assert.deepEqual(ref, out.pageNotes);
});
