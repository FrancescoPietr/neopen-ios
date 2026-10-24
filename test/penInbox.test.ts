import assert from "node:assert/strict";
import { test } from "node:test";
import { addToDaily, dailyPath, fillTemplate } from "../src/core/penInbox";
import { sameTitle } from "../src/core/similar";
import { parseTasks, toggleLines } from "../src/core/tasks";

const TPL = `<%* const d = moment(tp.file.title, "YYYYMMDD", true).isValid() ? moment(tp.file.title, "YYYYMMDD") : moment(); -%>
---
date: <% d.format("YYYY-MM-DD") %>T<% tp.date.now("HH:mm") %>
tags:
  - Daily
cssclasses:
  - daily
  - <% d.locale("it").format("dddd").toLowerCase() %>
---
# NOTA GIORNALIERA

## <% d.locale("it").format("dddd D MMMM YYYY") %>

---
`;

const DAILY_23 = `---
date: 2026-10-23T03:11
tags:
  - Daily
---
# NOTA GIORNALIERA

---

### Attività

<!-- neopen:testo:3_27_746_14 -->
- [ ] 11:00 trovare n° 2 domani 📅 2026-10-24
<!-- /neopen:testo:3_27_746_14 -->
`;

test("daily note path and the user's Templater template", () => {
  assert.equal(dailyPath({ folder: "Daily", format: "", template: "" }, "2026-10-23"), "Daily/2026-10-23.md");
  assert.equal(dailyPath({ folder: "/Diario/", format: "DD-MM-YYYY", template: "" }, "2026-10-23"), "Diario/23-10-2026.md");
  const out = fillTemplate(TPL, "2026-10-23", "2026-10-23", new Date(2026, 9, 23, 17, 44));
  assert.equal(
    out,
    "---\ndate: 2026-10-23T17:44\ntags:\n  - Daily\ncssclasses:\n  - daily\n  - venerdì\n---\n# NOTA GIORNALIERA\n\n## venerdì 23 ottobre 2026\n\n---\n"
  );
});

test("pen tasks go under «Attività», after the plugin's block, with a ^penna- id", () => {
  const out = addToDaily(DAILY_23, [{ title: "completare App", date: "" }, { title: "chiamare Marco", date: "2026-10-25" }], "2026-10-23", null);
  const lines = out.split("\n");
  const i = lines.indexOf("<!-- /neopen:testo:3_27_746_14 -->");
  assert.match(lines[i + 1], /^$/);
  assert.match(lines[i + 2], /^- \[ \] completare App \^penna-[a-z0-9]+$/);
  assert.match(lines[i + 3], /^- \[ \] chiamare Marco 📅 2026-10-25 \^penna-[a-z0-9]+$/);
  const ts = parseTasks(out, { path: "Daily/2026-10-23.md", dailyDate: "2026-10-23" });
  const app = ts.find((t) => t.title === "completare App")!;
  assert.equal(app.date, "2026-10-23");
  assert.ok(app.blockId?.startsWith("penna-"));
  // ticking keeps the block id (Obsidian can still take the line over)
  assert.match(toggleLines(app, "2026-10-23")[0], /^- \[x\] completare App ✅ 2026-10-23 \^penna-/);
  // a second batch goes right under the first one
  const again = addToDaily(out, [{ title: "pagare bolletta", date: "" }], "2026-10-23", null).split("\n");
  const j = again.findIndex((l) => l.includes("chiamare Marco"));
  assert.match(again[j + 1], /^- \[ \] pagare bolletta \^penna-/);
});

test("a daily note that does not exist yet starts from the template; one without the section gets it", () => {
  const out = addToDaily(null, [{ title: "completare App", date: "" }], "2026-10-24", TPL, new Date(2026, 9, 24, 9, 5));
  assert.match(out, /^---\ndate: 2026-10-24T09:05\n/);
  assert.match(out, /## sabato 24 ottobre 2026\n\n---\n\n### Attività\n\n- \[ \] completare App \^penna-\w+\n$/);
  assert.match(addToDaily("# Altro\n", [{ title: "x y z", date: "" }], "2026-10-24", null), /^# Altro\n\n### Attività\n\n- \[ \] x y z \^penna-\w+\n$/);
});

test("same task read twice", () => {
  assert.ok(sameTitle("andare alla gentita", "Andare alla gentita!"));
  assert.ok(sameTitle("completare App", "completare l'app"));
  assert.ok(sameTitle("completare App", "completare App NeoPen"));
  assert.ok(sameTitle("chiamare dentista", "chiamare dentista #salute"));
  assert.ok(!sameTitle("palestra", "pasta"));
  assert.ok(!sameTitle("comprare latte", "comprare pane"));
});
