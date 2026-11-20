// The whole flow with a simulated pen: connection, memory, acks, live mode, interruptions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PageKey } from "../src/core/models";
import { PenSession, SessionError, SessionNote, SessionOptions, defaultOptions } from "../src/core/session";
import { MemoryFiles, PageStore } from "../src/core/store";
import { FakePen, makeStrokes } from "./fakePen";

const k5: PageKey = { section: 3, owner: 27, note: 746, page: 5 };
const k9: PageKey = { section: 3, owner: 27, note: 746, page: 9 };
const other: PageKey = { section: 3, owner: 27, note: 600, page: 2 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(pen: FakePen, store: PageStore, opts: Partial<SessionOptions> = {}) {
  const s = new PenSession(store, { ...defaultOptions(), ...opts });
  s.link = pen;
  pen.session = s;
  return s;
}

async function rejectsWith(p: Promise<unknown>, kind: SessionError["kind"]) {
  await assert.rejects(p, (e: unknown) => e instanceof SessionError && e.kind === kind);
}

test("full sync, then nothing new; archive survives a restart", async () => {
  const pen = new FakePen();
  pen.put(k5, makeStrokes(7, 1_792_300_000_000));
  pen.put(k9, makeStrokes(10, 1_792_370_000_000));
  pen.put(other, makeStrokes(2, 1_792_100_000_000));
  const files = new MemoryFiles();
  const store = new PageStore(files);
  const s = connect(pen, store);
  const notes: string[] = [];
  s.note = (n: SessionNote) => { if (n.type === "pageUpdated") notes.push(`${n.key.page}:${n.newStrokes}`); };
  await s.start();
  assert.ok(pen.liveOn, "live mode requested");
  assert.ok(pen.clockSet > 1_700_000_000_000, "pen clock set");
  assert.equal(s.version?.deviceName, "NWP-F51");
  const r = await s.syncMemory();
  assert.deepEqual(r, { pages: 3, newStrokes: 19 });
  // highest notebook and last page first
  assert.deepEqual(pen.requestedPages, [k9, k5, other]);
  assert.deepEqual(store.record(k9).strokes, makeStrokes(10, 1_792_370_000_000));
  assert.equal(store.record(k9).penCount, 10);
  // 10 strokes at 3 per packet = 4 packets, 3 acks; 7 → 3 packets, 2; 2 → 1, 0; and the last packet of each page
  // is acknowledged too, closing the transfer (after the page is saved)
  assert.equal(pen.acks, 5);
  assert.equal(pen.endAcks, 3);
  assert.equal(pen.deletedPages.length, 0, "without the option nothing is deleted from the pen");
  assert.equal(notes.length, 3);
  assert.deepEqual(await s.syncMemory(), { pages: 0, newStrokes: 0 });
  const reopened = new PageStore(files);
  assert.equal(reopened.record(k9).strokes.length, 10);
  assert.equal(reopened.pendingUploads.length, 3);
});

test("resume after the pen powers off mid-transfer", async () => {
  const pen = new FakePen();
  pen.put(k5, makeStrokes(4, 1_792_300_000_000));
  pen.put(k9, makeStrokes(9, 1_792_370_000_000));
  pen.powerOffAfterPackets = 2; // in the middle of page 9 (3 packets)
  const store = new PageStore(new MemoryFiles());
  const s = connect(pen, store);
  await s.start();
  await rejectsWith(s.syncMemory(), "closed");
  assert.equal(store.record(k9).strokes.length, 0, "a half page is not saved half");
  pen.powerOffAfterPackets = null;
  const s2 = connect(pen, store);
  await s2.start();
  assert.equal((await s2.syncMemory()).newStrokes, 13);
  assert.equal(store.record(k9).strokes.length, 9);
  assert.equal(store.record(k5).strokes.length, 4);
});

test("live strokes while connected", async () => {
  const pen = new FakePen();
  const store = new PageStore(new MemoryFiles());
  const s = connect(pen, store);
  const updates: number[] = [];
  s.note = (n) => { if (n.type === "pageUpdated") updates.push(n.key.page); };
  await s.start();
  const live = makeStrokes(3, 1_792_400_000_000, 40, 50);
  for (const st of live) pen.writeLive(k9, st);
  await sleep(300);
  const saved = store.record(k9).strokes;
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.map((x) => x.t), live.map((x) => x.t));
  assert.deepEqual(saved[0].pts, live[0].pts);
  assert.deepEqual(updates, [9, 9, 9]);
  pen.shutdown();
  await sleep(50);
  s.linkClosed();
  assert.ok(s.closed);
});

test("live and offline don't duplicate", async () => {
  const pen = new FakePen();
  const strokes = makeStrokes(5, 1_792_500_000_000);
  pen.put(k9, strokes);
  const store = new PageStore(new MemoryFiles());
  store.add(strokes.slice(0, 2), k9);
  const s = connect(pen, store);
  await s.start();
  assert.equal((await s.syncMemory()).newStrokes, 3);
  assert.equal(store.record(k9).strokes.length, 5);
});

test("password", async () => {
  const pen = new FakePen();
  pen.password = "4321";
  pen.lock();
  const store = new PageStore(new MemoryFiles());
  await rejectsWith(connect(pen, store).start(), "passwordNeeded");
  await rejectsWith(connect(pen, store, { password: "1111" }).start(), "wrongPassword");
  await connect(pen, store, { password: "4321" }).start();
  assert.ok(pen.liveOn);
});

test("empty read is retried", async () => {
  const pen = new FakePen();
  pen.put(k9, makeStrokes(4, 1_792_370_000_000));
  pen.refuseTimes.set("3_27_746_9", 1);
  const s = connect(pen, new PageStore(new MemoryFiles()));
  await s.start();
  assert.deepEqual(await s.download(k9), { kind: "read", count: 4, newStrokes: 4 });
  assert.deepEqual(pen.requestedPages, [k9, k9]);
});

test("delete after download", async () => {
  const pen = new FakePen();
  pen.put(k9, makeStrokes(4, 1_792_370_000_000));
  const store = new PageStore(new MemoryFiles());
  const s = connect(pen, store, { deleteAfterDownload: true });
  await s.start();
  await s.syncMemory();
  assert.deepEqual(pen.deletedPages, [k9]);
  assert.equal(store.record(k9).strokes.length, 4);
  assert.equal((await s.syncMemory()).pages, 0);
  assert.equal(pen.memory.size, 0);
});

test("timeout when the pen doesn't answer", async () => {
  const pen = new FakePen();
  pen.mute = true;
  const t0 = Date.now();
  await rejectsWith(connect(pen, new PageStore(new MemoryFiles())).start(), "timeout");
  assert.ok(Date.now() - t0 < 15000);
});

test("store: strokes written with the pen clock reset (battery died) get today's time, the same way every time", async () => {
  const { PageStore, MemoryFiles } = await import("../src/core/store");
  const files = new MemoryFiles();
  const store = new PageStore(files);
  const key = { section: 3, owner: 27, note: 746, page: 30 };
  const mk = (t: number) => ({ t, tip: 0, color: 0, pts: [1, 1, 500, 2, 2, 500] });
  const now = Date.UTC(2026, 10, 20, 8);
  // two strokes at "year 2000" pen time
  const a = [mk(946_684_800_000), mk(946_684_805_000)];
  store.fixClock(a, now);
  assert.equal(a[1].t, now);
  assert.equal(a[0].t, now - 5000);
  // the pen sends them again later (memory kept): same times, no duplicates
  const b = [mk(946_684_800_000), mk(946_684_805_000)];
  store.fixClock(b, now + 3_600_000);
  assert.deepEqual(b.map((s) => s.t), a.map((s) => s.t));
  // normal strokes are untouched
  const c = [mk(now)];
  assert.equal(store.fixClock(c, now), 0);
  assert.equal(c[0].t, now);
  assert.equal(store.add(a, key), 2);
  assert.equal(store.add(b, key), 0);
});
