// Nell'editor: le righe accanto a un disegno (blocco ```neopen-disegno con "accanto:" e "grandezze:")
// prendono la grandezza che avevano sulla carta (es. la scritta piccola "#Invertix", quella grande "Prometheus").

import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { DRAWING_BLOCK, parseDrawingBlock } from "../transcribe/drawings";

/**
 * Dopo le righe accanto al disegno: uno spazio alto quanto serve perché il testo che segue riparta sotto il disegno
 * (se il disegno è più alto delle righe accanto). Misurato sulla pagina, così l'editor sa dove sta ogni riga.
 */
class ClearSpacer extends WidgetType {
  private ro: ResizeObserver | null = null;
  eq(): boolean {
    return false;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "neopen-beside-spacer";
    const fit = () => {
      if (!el.isConnected) return;
      let n = el.previousElementSibling;
      let d: HTMLElement | null = null;
      for (let i = 0; n && i < 40 && !d; i++, n = n.previousElementSibling) d = n.querySelector<HTMLElement>(".neopen-drawing.is-beside");
      const cur = el.offsetHeight;
      const want = d ? Math.max(0, Math.round(d.getBoundingClientRect().bottom - el.getBoundingClientRect().top)) : 0;
      if (Math.abs(want - cur) > 1) {
        el.style.height = `${want}px`;
        view.requestMeasure();
      }
      if (d && !this.ro) {
        this.ro = new ResizeObserver(() => requestAnimationFrame(fit));
        this.ro.observe(d);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(fit));
    return el;
  }
  destroy(): void {
    this.ro?.disconnect();
    this.ro = null;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const b = new RangeSetBuilder<Decoration>();
  const open = "```" + DRAWING_BLOCK;
  let found = false;
  for (let i = 1; i <= doc.lines; i++) {
    if (!doc.line(i).text.startsWith(open)) continue;
    found = true;
    let j = i + 1;
    const body: string[] = [];
    while (j <= doc.lines && doc.line(j).text.trim() !== "```") body.push(doc.line(j++).text);
    const spec = parseDrawingBlock(body.join("\n"));
    const beside = spec.beside;
    const sizes = beside?.sizes ?? [];
    let k = j + 1,
      n = 0,
      last = -1;
    // le righe delle scritte: si vedono sopra il disegno, qui si nascondono (tranne quando ci sei col cursore)
    if (spec.anchors.length) {
      let from = -1,
        to = -1,
        got = 0;
      while (k <= doc.lines && got < spec.anchors.length) {
        const line = doc.line(k);
        const t = line.text.trim();
        if (t.startsWith("<!--") || t.startsWith("```")) break;
        k++;
        if (!t) continue;
        if (from < 0) from = line.from;
        to = line.to;
        got++;
      }
      const sel = state.selection.ranges.some((r) => r.to >= from && r.from <= to);
      if (from >= 0 && !sel) b.add(from, to, Decoration.replace({ block: true }));
    }
    while (beside && k <= doc.lines && n < beside.lines) {
      const line = doc.line(k++);
      if (!line.text.trim()) continue;
      const s = sizes[n++];
      if (s && s !== 1) b.add(line.from, line.from, Decoration.line({ attributes: { style: `font-size: ${s}em` } }));
      last = line.to;
    }
    if (last >= 0) b.add(last, last, Decoration.widget({ widget: new ClearSpacer(), block: true, side: 1 }));
    i = j;
  }
  return found ? b.finish() : Decoration.none;
}

export const besideSizesField = StateField.define<DecorationSet>({
  create: (s) => build(s),
  update: (deco, tr) => (tr.docChanged || tr.selection ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});
