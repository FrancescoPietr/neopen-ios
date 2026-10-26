// I disegni nelle note: il blocco ```neopen-disegno``` mostra i tratti del disegno (sfondo trasparente, inchiostro
// nero o bianco a seconda dello sfondo della nota) e sopra le scritte come testo vero, col font della nota.
// Le scritte si spostano trascinandole, si modificano con un click e si cancellano svuotandole.

import { App, MarkdownPostProcessorContext, Plugin, TFile } from "obsidian";
import { Anchor, DRAWING_BLOCK, LabelPos, escapeLabelLine, unescapeLabelLine, formatDrawingBlock, linesAfterBlock, parseDrawingBlock, replaceDrawingBlock } from "../transcribe/drawings";

const NS = "http://www.w3.org/2000/svg";

/** Disegni con le scritte prese dalle righe della nota: si aggiornano quando la nota cambia. */
const live = new Set<{ box: HTMLElement; path: string; refresh: () => void }>();

export function registerDrawingBlocks(plugin: Plugin): void {
  plugin.registerMarkdownCodeBlockProcessor(DRAWING_BLOCK, (src, el, ctx) => renderDrawing(plugin.app, src, el, ctx));
  plugin.registerEvent(
    plugin.app.vault.on("modify", (f) => {
      for (const l of [...live]) {
        if (!l.box.isConnected) live.delete(l);
        else if (l.path === f.path) l.refresh();
      }
    })
  );
  // tema o sfondo cambiati: si ricontrolla il colore dell'inchiostro
  plugin.registerEvent(
    plugin.app.workspace.on("css-change", () => {
      document.querySelectorAll<HTMLElement>(".neopen-drawing").forEach((b) => adapt(b));
    })
  );
}

async function renderDrawing(app: App, src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  const spec = parseDrawingBlock(src);
  const box = el.createDiv({ cls: "neopen-drawing" });
  const file = app.vault.getAbstractFileByPath(spec.file);
  if (!(file instanceof TFile)) {
    box.addClass("is-missing");
    box.setText(`Disegno non trovato: ${spec.file || "(manca la riga file:)"}`);
    return;
  }

  // solo i tratti: un SVG nuovo con i path del file (niente altro dal file entra nella pagina)
  const doc = new DOMParser().parseFromString(await app.vault.cachedRead(file), "image/svg+xml");
  const src_ = doc.documentElement;
  const svg = document.createElementNS(NS, "svg");
  const vb = src_.getAttribute("viewBox");
  if (vb) svg.setAttribute("viewBox", vb);
  const g = document.createElementNS(NS, "g");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "currentColor");
  // colore pieno, nero o bianco: lo stile in linea vale più dei temi (che schiariscono gli svg nella pagina)
  g.style.stroke = "var(--neopen-ink, #000000)";
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  src_.querySelectorAll("path").forEach((p) => {
    const d = p.getAttribute("d");
    if (!d) return;
    const q = document.createElementNS(NS, "path");
    q.setAttribute("d", d);
    q.setAttribute("stroke-width", p.getAttribute("stroke-width") ?? "2");
    g.appendChild(q);
  });
  svg.appendChild(g);
  box.appendChild(svg);
  const mm = parseFloat(src_.getAttribute("width") ?? "");
  const [, , vw, vh] = (vb ?? "").split(/\s+/).map(Number);
  const overlay = spec.anchors.length > 0;
  if (overlay) box.addClass("has-labels");
  if (spec.beside && vw > 0 && vh > 0) {
    // testo accanto, come sulla carta: il disegno alto quanto quelle righe, e il testo gli scorre di fianco
    box.addClass("is-beside", spec.beside.side === "right" ? "text-right" : "text-left");
    // altezza = somma delle righe accanto (quelle scritte più grandi o più piccole contano di più o di meno)
    const rows = Array.from({ length: spec.beside.lines }, (_, i) => spec.beside!.sizes?.[i] ?? 1).reduce((a, b) => a + b, 0);
    box.style.setProperty("--neopen-rows", String(rows));
    if (spec.beside.sizes?.length) box.dataset.sizes = spec.beside.sizes.join(" ");
    box.style.setProperty("--neopen-ratio", String(vw / vh));
    // mai più piccolo di com'è sulla carta (un po' ridotto): con due scritte accanto il logo resta un logo
    const mmH = parseFloat(src_.getAttribute("height") ?? "");
    if (mmH > 0) box.style.setProperty("--neopen-nat", `${(mmH * 0.8).toFixed(1)}mm`);
  } else if (mm > 0) box.style.width = `min(100%, ${mm}mm)`;

  const labels = spec.labels.map((l) => ({ ...l }));
  const save = async (): Promise<void> => {
    const note = app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(note instanceof TFile)) return;
    const block = formatDrawingBlock(spec.file, labels, spec.beside);
    await app.vault.process(note, (c) => replaceDrawingBlock(c, spec.file, block));
  };

  for (const l of labels) addLabel(app, box, l, labels, save, ctx.sourcePath);
  if (overlay) {
    const entry = { box, path: ctx.sourcePath, refresh: () => void showLineLabels(app, box, spec.file, spec.anchors, ctx.sourcePath, spec.beside) };
    live.add(entry);
    entry.refresh();
  }

  // il colore dipende da dove finisce il blocco: si guarda appena è nella pagina
  let tries = 0;
  const wait = () => {
    if (box.isConnected) adapt(box);
    else if (tries++ < 120) requestAnimationFrame(wait);
  };
  wait();
}

function place(span: HTMLElement, l: LabelPos): void {
  span.style.left = `${l.x}%`;
  span.style.top = `${l.y}%`;
  span.style.fontSize = `${l.size}cqw`;
  if (l.w) span.dataset.w = String(l.w);
  span.dataset.size = String(l.size);
  fitLabel(span);
}

/**
 * Il testo battuto non deve uscire dalla larghezza della scrittura a mano (altrimenti due note vicine si
 * sovrappongono): se è più largo, si rimpicciolisce. Si misura quando la scritta è nella pagina.
 */
function fitLabel(span: HTMLElement, tries = 0): void {
  const w = Number(span.dataset.w),
    size = Number(span.dataset.size);
  if (!w || !size) return;
  const box = span.parentElement;
  if (!span.isConnected || !box || !box.clientWidth) {
    if (tries < 120) requestAnimationFrame(() => fitLabel(span, tries + 1));
    return;
  }
  span.style.fontSize = `${size}cqw`;
  const target = (box.clientWidth * w) / 100;
  const real = span.offsetWidth;
  if (real > target * 1.1) span.style.fontSize = `${Math.max(size * 0.45, (size * target * 1.1) / real).toFixed(2)}cqw`;
}

function addLabel(app: App, box: HTMLElement, l: LabelPos, all: LabelPos[], save: () => Promise<void>, notePath: string): void {
  const span = box.createSpan({ cls: "neopen-drawing-label", text: l.text });
  place(span, l);
  wireLabel(box, span, l, {
    moved: () => void save(),
    edited: (text) => {
      const before = l.text;
      if (!text) {
        all.splice(all.indexOf(l), 1);
        span.remove();
      } else {
        l.text = text;
        span.setText(text);
      }
      void save().then(() => addNewTags(app, notePath, before, text));
    },
  });
}

/** Trascina per spostare (cambia l.x/l.y, poi moved), click per modificare (edited col testo nuovo, "" = cancella). */
function wireLabel(box: HTMLElement, span: HTMLElement, l: LabelPos, on: { moved: () => void; edited: (text: string) => void }): void {
  span.setAttr("aria-label", "Trascina per spostare, click per modificare");
  const stop = (e: Event) => e.stopPropagation();
  span.addEventListener("mousedown", stop);
  span.addEventListener("click", stop);

  span.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY,
      x0 = l.x,
      y0 = l.y;
    let moved = false;
    span.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx,
        dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      span.addClass("is-dragging");
      l.x = Math.round((x0 + (dx / r.width) * 100) * 10) / 10;
      l.y = Math.round((y0 + (dy / r.height) * 100) * 10) / 10;
      place(span, l);
    };
    const up = () => {
      span.removeEventListener("pointermove", move);
      span.removeEventListener("pointerup", up);
      span.removeEventListener("pointercancel", up);
      span.removeClass("is-dragging");
      if (moved) on.moved();
      else edit();
    };
    span.addEventListener("pointermove", move);
    span.addEventListener("pointerup", up);
    span.addEventListener("pointercancel", up);
  });

  const edit = () => {
    const input = box.createEl("input", { cls: "neopen-drawing-input", type: "text", value: l.text });
    place(input, l);
    input.style.fontFamily = getComputedStyle(span).fontFamily;
    input.style.width = `${Math.max(4, l.text.length + 2)}ch`;
    span.style.visibility = "hidden";
    for (const ev of ["mousedown", "click", "pointerdown", "keydown", "keyup", "keypress", "beforeinput", "input"]) input.addEventListener(ev, stop);
    input.addEventListener("input", () => (input.style.width = `${Math.max(4, input.value.length + 2)}ch`));
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.replace(/\s+/g, " ").trim();
      input.remove();
      span.style.visibility = "";
      if (keep && text !== l.text) on.edited(text);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
}

/** Un #tag nuovo scritto in una scritta va anche nelle proprietà della nota. */
async function addNewTags(app: App, notePath: string, before: string, after: string): Promise<void> {
  const tags = (t: string) => [...t.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_\-/]*)/gu)].map((m) => m[1].toLowerCase());
  const old = new Set(tags(before));
  const add = tags(after).filter((t) => !old.has(t));
  const note = app.vault.getAbstractFileByPath(notePath);
  if (!add.length || !(note instanceof TFile)) return;
  await app.fileManager.processFrontMatter(note, (fm) => {
    const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
    const low = cur.map((c) => c.toLowerCase());
    const missing = add.filter((t) => !low.includes(t));
    if (missing.length) fm.tags = [...cur.filter(Boolean), ...missing];
  });
}

/** Inchiostro nero su sfondo chiaro, bianco su sfondo scuro; scritte col font del testo della nota. */
function adapt(box: HTMLElement): void {
  box.style.setProperty("--neopen-ink", luminanceBehind(box) < 0.18 ? "#ffffff" : "#000000");
  const host = box.closest(".cm-scroller, .markdown-preview-view");
  if (host) box.style.fontFamily = getComputedStyle(host).fontFamily;
  if (box.hasClass("is-beside")) {
    // altezza di una riga del testo che segue (quello che sta di fianco)
    const next = nextText(box);
    const lh = parseFloat(getComputedStyle(next ?? host ?? box).lineHeight);
    if (lh > 0) box.style.setProperty("--neopen-lh", `${lh}px`);
    // lettura: il paragrafo accanto comincia dopo il suo margine, il disegno parte alla stessa altezza
    box.style.marginTop = next?.tagName === "P" ? getComputedStyle(next).marginTop : "";
    // lettura: le righe accanto con la loro grandezza (nell'editor lo fa besideSizes)
    if (next?.tagName === "P" && box.dataset.sizes) sizeParagraphLines(next, box.dataset.sizes.split(" ").map(Number));
  }
}

/** Il primo elemento di testo dopo il blocco del disegno (modifica e lettura). */
function nextText(box: HTMLElement): HTMLElement | null {
  const lp = box.closest(".cm-embed-block, .cm-preview-code-block");
  let n = (lp ?? box.closest(".markdown-preview-section > *"))?.nextElementSibling as HTMLElement | null;
  for (let i = 0; n && i < 5; i++, n = n.nextElementSibling as HTMLElement | null) {
    if (n.hasClass("cm-line") && n.textContent?.trim()) return n;
    const p = n.querySelector("p");
    if (p) return p;
  }
  return null;
}

function luminanceBehind(el: HTMLElement): number {
  for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(n).backgroundColor);
    if (!m) continue;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if ((p.length > 3 ? p[3] : 1) < 0.5) continue;
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  }
  return document.body.hasClass("theme-dark") ? 0 : 1;
}

/** Nel paragrafo (righe separate da <br>): ogni riga nella sua grandezza. */
function sizeParagraphLines(p: HTMLElement, sizes: number[]): void {
  if (p.dataset.neopenSized) return;
  p.dataset.neopenSized = "1";
  const groups: Node[][] = [[]];
  for (const n of Array.from(p.childNodes)) {
    if (n.nodeName === "BR") groups.push([]);
    else groups[groups.length - 1].push(n);
  }
  groups.forEach((g, i) => {
    const s = sizes[i];
    if (!s || s === 1 || !g.length) return;
    const span = document.createElement("span");
    span.style.fontSize = `${s}em`;
    g[0].parentNode!.insertBefore(span, g[0]);
    for (const n of g) span.appendChild(n);
  });
}

/**
 * Le scritte del disegno sono le righe della nota subito dopo il blocco: qui si mostrano sopra il disegno,
 * nel punto e con la grandezza di "scritte:". Click = modifica la riga, trascina = sposta (cambia "scritte:").
 */
async function showLineLabels(app: App, box: HTMLElement, file: string, anchors: Anchor[], notePath: string, beside?: { side: "left" | "right"; lines: number; sizes?: number[] }): Promise<void> {
  const note = app.vault.getAbstractFileByPath(notePath);
  if (!(note instanceof TFile)) return;
  const content = await app.vault.cachedRead(note);
  const found = linesAfterBlock(content, file, anchors.length);
  box.querySelectorAll(".neopen-drawing-label.from-line").forEach((n) => n.remove());
  if (!found) return;
  const lines = content.split("\n");
  const texts = found.after.map((k) => unescapeLabelLine(lines[k].replace(/\r$/, "").trim()));
  const pos = anchors.map((a) => ({ ...a }));
  box.dataset.labelLines = String(texts.length);

  // scrive nella nota: nuove posizioni e/o testo della riga i (null = cancella la scritta)
  const write = async (i: number, text?: string | null): Promise<void> => {
    await app.vault.process(note, (c) => {
      const f = linesAfterBlock(c, file, anchors.length);
      if (!f) return c;
      const ls = c.split("\n");
      const keep = pos.filter((_, k) => !(text === null && k === i));
      const block = formatDrawingBlock(file, [], beside, keep).split("\n");
      if (text === null && f.after[i] !== undefined) ls.splice(f.after[i], 1);
      else if (typeof text === "string" && f.after[i] !== undefined) ls[f.after[i]] = escapeLabelLine(text);
      ls.splice(f.open, f.close - f.open + 1, ...block);
      return ls.join("\n");
    });
  };

  texts.forEach((text, i) => {
    const a = pos[i];
    if (!a) return;
    const l: LabelPos = { ...a, text };
    const span = box.createSpan({ cls: "neopen-drawing-label from-line", text });
    place(span, l);
    wireLabel(box, span, l, {
      moved: () => {
        pos[i] = { x: l.x, y: l.y, size: l.size };
        void write(i);
      },
      edited: (t) => void write(i, t || null),
    });
  });
  hideLabelParagraph(box, texts.length);
  // i font si caricano dopo: si rimisura
  void document.fonts?.ready.then(() => box.querySelectorAll<HTMLElement>(".neopen-drawing-label").forEach((s) => fitLabel(s)));
}

/** Lettura: le righe delle scritte (mostrate sopra il disegno) non si ripetono sotto. */
function hideLabelParagraph(box: HTMLElement, n: number): void {
  const sec = box.closest(".markdown-preview-section > *");
  const p = sec?.nextElementSibling?.querySelector("p");
  if (!p || p.dataset.neopenHidden) return;
  p.dataset.neopenHidden = "1";
  let left = n;
  for (const node of Array.from(p.childNodes)) {
    if (left <= 0) break;
    if (node.nodeName === "BR") left--;
    if (node.nodeType === Node.TEXT_NODE && node.textContent === "\n" && left <= 0) break;
    node.remove();
  }
  if (!p.textContent?.trim()) (p.parentElement ?? p).style.display = "none";
}
