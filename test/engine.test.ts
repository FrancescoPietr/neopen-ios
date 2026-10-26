// The Obsidian plugin's engine running "on the phone" (as in the app): a small invented vault on disk, a fake Claude.
(globalThis as { window?: unknown }).window ??= globalThis;
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { transcribePages } from "../plugin/src/phone/engine";
import { App, TFile } from "../plugin/src/phone/obsidian";
import { SoftCanvas } from "../plugin/src/phone/canvas";
import { fillTemplate } from "../src/core/penInbox";
import { NodeVaultIO } from "./vaultFs";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

/** A stroke that looks like handwriting (a zig-zag word) on line `row`, from x. */
function word(t: number, x: number, row: number): { t: number; tip: number; color: number; pts: number[] } {
  const pts: number[] = [];
  for (let i = 0; i < 12; i++) pts.push(x + i * 0.6, 20 + row * 6 + (i % 2 ? 1.6 : 0), 500);
  return { t, tip: 0, color: 0, pts };
}

function page(day: number, rows: number) {
  const strokes = [];
  for (let r = 0; r < rows; r++) for (let w = 0; w < 4; w++) strokes.push(word(at(day, 9, 30) + r * 10_000 + w * 1000, 10 + w * 9, r));
  return strokes;
}

function vault(): { root: string; io: NodeVaultIO } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const io = new NodeVaultIO(root);
  io.write(".obsidian/core-plugins.json", JSON.stringify({ "daily-notes": true, templates: false }));
  io.write(".obsidian/daily-notes.json", JSON.stringify({ folder: "Daily", template: "Templates/Giorno.md" }));
  io.write(".obsidian/community-plugins.json", JSON.stringify(["templater-obsidian", "neo-pen"]));
  io.write(".obsidian/plugins/templater-obsidian/data.json", JSON.stringify({ templates_folder: "Templates" }));
  io.write(
    ".obsidian/plugins/neo-pen/data.json",
    JSON.stringify({
      apiKey: "chiave-di-prova",
      notesFolder: "Me",
      notebookFolder: "Taccuino {{inizio}}",
      rules: [{ tags: ["task", "tasks"], action: "daily", template: "", folder: "", title: "", heading: "### Attività", drawing: false, calendar: false }],
      settingsVersion: 13,
      pageIndex: {},
      pageNotes: {},
    })
  );
  io.write("Templates/Giorno.md", '<%* const d = moment(); -%>\n---\ndate: <% d.format("YYYY-MM-DD") %>\n---\n# <% d.locale("it").format("dddd") %>\n');
  return { root, io };
}

function options(io: NodeVaultIO, answer: object, calls: { n: number }, log: string[] = []) {
  return {
    io,
    vaultName: "Prova",
    deviceId: "app-telefono",
    log: (m: string) => log.push(m),
    templater: (c: string, f: { basename: string }) => fillTemplate(c, /^\d{4}-\d{2}-\d{2}$/.test(f.basename) ? f.basename : "2026-10-26", f.basename),
    request: async () => {
      calls.n++;
      return { status: 200, text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 1000, output_tokens: 100 } }) };
    },
  };
}

const answer = (lines: string[], extra: object = {}) => ({
  lines,
  tags: ["task"],
  page_tag: "task",
  page_title: "",
  new_titles: [],
  title_tags: [],
  corrections: [],
  checked_tasks: [],
  deleted_text: [],
  arrows: [],
  replies: [],
  drawings: [],
  continues_last_line: false,
  ...extra,
});

const key = (n: number) => ({ section: 3, owner: 27, note: 746, page: n });

test("engine: a #task page goes to the daily note, taking over the line the phone had put there", async () => {
  const { io } = vault();
  io.write("Daily/2026-10-26.md", "# lunedì\n\n### Attività\n\n- [ ] comprare il pane ^penna-abc123\n");
  const calls = { n: 0 };
  const log: string[] = [];
  const r = await transcribePages(options(io, answer(["[ ] chiamare Marco", "[ ] comprare il pane"]), calls, log), [{ key: key(20), strokes: page(26, 2) }]);
  assert.equal(r.status, "ok", log.join("\n"));
  assert.equal(calls.n, 1);
  const daily = io.read("Daily/2026-10-26.md")!;
  assert.equal(daily.match(/comprare il pane/g)?.length, 1, daily);
  assert.match(daily, /- \[ \] chiamare Marco/);
  assert.doesNotMatch(daily, /\^penna-/);
  const s = JSON.parse(io.read(".obsidian/plugins/neo-pen/data.json")!);
  assert.equal(s.pageNotes["3_27_746_20"].path, "Daily/2026-10-26.md");
  assert.ok(s.pageIndex["3_27_746_20"].done >= at(26, 9, 30));
  const saved = JSON.parse(io.read("NeoPen/_pagine/3_27_746_20.json")!);
  assert.ok(saved.strokes.every((st: { tx?: number }) => st.tx), "strokes marked as transcribed");
  // nothing new: nothing to do, no call to Claude
  const again = await transcribePages(options(io, answer([]), calls), [{ key: key(20), strokes: page(26, 2) }]);
  assert.equal(again.status, "nothing");
  assert.equal(calls.n, 1);
});

test("engine: a new daily note starts from the template (Templater commands run)", async () => {
  const { io } = vault();
  const calls = { n: 0 };
  const r = await transcribePages(options(io, answer(["[ ] dentista"]), calls), [{ key: key(21), strokes: page(27, 1) }]);
  assert.equal(r.status, "ok");
  const daily = io.read("Daily/2026-10-27.md")!;
  assert.doesNotMatch(daily, /<%/);
  assert.match(daily, /^---\ndate: 2026-10-27\n/);
  assert.match(daily, /# martedì/);
  assert.match(daily, /### Attività[\s\S]*- \[ \] dentista/);
});

test("engine: waits when another device is transcribing; needs the plugin's settings and key", async () => {
  const { io } = vault();
  io.write("NeoPen/_turno.json", JSON.stringify({ device: "obsidian-iphone", until: Date.now() + 60_000 }));
  const calls = { n: 0 };
  const busy = await transcribePages(options(io, answer(["[ ] x"]), calls), [{ key: key(22), strokes: page(26, 1) }]);
  assert.deepEqual(busy, { status: "busy", device: "obsidian-iphone" });
  assert.equal(calls.n, 0);
  const empty = new NodeVaultIO(fs.mkdtempSync(path.join(os.tmpdir(), "vuoto-")));
  assert.equal((await transcribePages(options(empty, answer([]), calls), [{ key: key(22), strokes: page(26, 1) }])).status, "no-settings");
});

test("phone Obsidian: rename updates the links, properties are written as YAML", async () => {
  const { io } = vault();
  io.write("Me/Idea.md", "---\ntags:\n  - prova\n---\ntesto\n");
  io.write("Me/Altra.md", "vedi [[Idea]] e ![[Idea|qui]]\n");
  const app = new App(io, "Prova");
  const f = app.vault.getAbstractFileByPath("Me/Idea.md") as TFile;
  await app.fileManager.processFrontMatter(f, (fm) => fm.tags.push("nuovo"));
  assert.equal(io.read("Me/Idea.md"), "---\ntags:\n  - prova\n  - nuovo\n---\ntesto\n");
  await app.fileManager.renameFile(f, "Me/Idea bella.md");
  assert.equal(io.read("Me/Altra.md"), "vedi [[Idea bella]] e ![[Idea bella|qui]]\n");
  assert.equal(app.vault.getAbstractFileByPath("Me/Idea.md"), null);
  assert.ok(app.vault.getAbstractFileByPath("Me/Idea bella.md") instanceof TFile);
  await assert.rejects(app.vault.create("Me/Altra.md", "x"));
});

test("phone canvas: draws strokes into a real PNG", () => {
  const c = new SoftCanvas(40, 20);
  const ctx = c.getContext();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(5, 10);
  ctx.lineTo(35, 10);
  ctx.stroke();
  assert.equal(c.data[(10 * 40 + 20) * 3], 0, "black in the middle of the line");
  assert.equal(c.data[(2 * 40 + 20) * 3], 255, "white away from it");
  const png = c.png();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("engine: a time written inside the line makes it an appointment ('andare a mangiare alle 12:00')", async () => {
  const { io } = vault();
  const calls = { n: 0 };
  const log: string[] = [];
  const r = await transcribePages(options(io, answer(["[ ] andare a mangiare alle 12:00", "[ ] Andare 13:30 in palestra", "[ ] guardare minuto 1:26"]), calls, log), [{ key: key(23), strokes: page(26, 3) }]);
  assert.equal(r.status, "ok", log.join("\n"));
  const daily = io.read("Daily/2026-10-26.md")!;
  assert.match(daily, /- \[ \] 12:00 andare a mangiare/, daily);
  assert.match(daily, /- \[ \] 13:30 Andare in palestra/, daily);
  assert.match(daily, /- \[ \] guardare minuto 1:26/, daily);
});
