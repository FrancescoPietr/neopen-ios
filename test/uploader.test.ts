import assert from "node:assert/strict";
import { test } from "node:test";
import { PageKey, PageRecord, mergeStrokes, newRecord, pageId } from "../src/core/models";
import { PageSender, RelayClient } from "../src/core/relay";
import { MemoryFiles, PageStore } from "../src/core/store";
import { Uploader } from "../src/core/uploader";
import { makeStrokes } from "./fakePen";

const a: PageKey = { section: 3, owner: 27, note: 746, page: 8 };
const b: PageKey = { section: 3, owner: 27, note: 746, page: 9 };

class FakeScript implements PageSender {
  received: [string, number][] = [];
  failNext = 0;
  onPut: (() => void) | null = null;
  async put(r: PageRecord) {
    this.onPut?.();
    if (this.failNext > 0) { this.failNext--; throw new Error("rete assente"); }
    this.received.push([pageId(r.key), r.strokes.length]);
  }
}

test("uploads changed pages once", async () => {
  const store = new PageStore(new MemoryFiles());
  store.add(makeStrokes(3, 1000), a);
  store.add(makeStrokes(5, 9000), b);
  const up = new Uploader(store);
  const script = new FakeScript();
  up.client = script;
  await up.flush();
  assert.equal(script.received.length, 2);
  assert.equal(store.pendingUploads.length, 0);
  await up.flush();
  assert.equal(script.received.length, 2);
  store.add(makeStrokes(1, 50000), b);
  await up.flush();
  assert.deepEqual(script.received.at(-1), [pageId(b), 6]);
});

test("a failure keeps pages pending", async () => {
  const store = new PageStore(new MemoryFiles());
  store.add(makeStrokes(3, 1000), a);
  const up = new Uploader(store);
  const script = new FakeScript();
  script.failNext = 1;
  up.client = script;
  await up.flush();
  assert.equal(store.pendingUploads.length, 1);
  assert.ok(up.lastError);
  await up.flush();
  assert.equal(store.pendingUploads.length, 0);
  assert.equal(up.lastError, null);
  up.cancel(); // the retry scheduled after the failure
});

test("strokes arriving during an upload stay pending", async () => {
  const store = new PageStore(new MemoryFiles());
  store.add(makeStrokes(3, 1000), a);
  const up = new Uploader(store);
  const script = new FakeScript();
  script.onPut = () => store.add(makeStrokes(1, 70000), a);
  up.client = script;
  await up.flush();
  assert.equal(store.record(a).strokes.length, 4);
  assert.equal(store.record(a).sentCount, 3);
  assert.equal(store.pendingUploads.length, 1);
});

test("request body matches the script", () => {
  const r = newRecord(b);
  mergeStrokes(r, [{ t: 1_792_370_000_123, tip: 0, color: 4278190080, pts: [12.345, 67.891, 512, 13, 68, 600] }]);
  const body = JSON.parse(new RelayClient("https://script.google.com/macros/s/X/exec", "abcdef123456").putBody(r));
  assert.equal(body.secret, "abcdef123456");
  assert.equal(body.relay.action, "put");
  assert.deepEqual(body.relay.pages[0], { id: "3_27_746_9", count: 1, strokes: [{ t: 1_792_370_000_123, tip: 0, color: 4278190080, pts: [12.35, 67.89, 512, 13, 68, 600] }] });
});

test("script answers and requests through fetch", async () => {
  assert.doesNotThrow(() => RelayClient.check('{"ok":true,"saved":1}'));
  assert.throws(() => RelayClient.check('{"ok":false,"error":"secret"}'), /chiave segreta/);
  assert.throws(() => RelayClient.check('{"results":[]}'), /vecchia/);
  assert.throws(() => RelayClient.check("<!DOCTYPE html><html>login</html>"), /Chiunque/);
  assert.ok(RelayClient.looksValid("https://script.google.com/macros/s/AKfy/exec", "0123456789abcdef"));
  assert.ok(!RelayClient.looksValid("https://example.com/exec", "0123456789abcdef"));
  let seen: RequestInit | undefined;
  const fake = (async (_url: any, init?: RequestInit) => { seen = init; return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch;
  await new RelayClient("https://script.google.com/macros/s/X/exec", "abcdef123456", fake).ping();
  assert.equal(seen?.method, "POST");
  assert.equal((seen?.headers as any)["Content-Type"], "text/plain;charset=utf-8");
});
