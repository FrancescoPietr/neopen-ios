// Nasconde (o mostra) nell'editor i marcatori dei blocchi del plugin:
//   <!-- neopen:testo:3_27_746_5 -->  …  <!-- /neopen:testo:3_27_746_5 -->
// Nel file restano sempre: servono al plugin per sapere dove scrivere ogni pagina.
// - nascosti: le righe dei marcatori spariscono, il testo delle pagine scorre unico e continuo;
// - mostrati: i marcatori si vedono e sopra ogni pagina compare un'etichetta "Pagina N".
// (In modalità lettura i commenti HTML sono comunque invisibili.)

import { RangeSetBuilder, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

const MARKER = /^\s*<!--\s*(\/?)neopen:testo(?::(\d+)_(\d+)_(\d+)_(\d+)(?:~\d+)?)?\s*-->\s*$/;

class PageLabel extends WidgetType {
  constructor(private note: string, private page: string) {
    super();
  }
  eq(other: PageLabel): boolean {
    return other.note === this.note && other.page === this.page;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "neopen-page-label-inline";
    el.textContent = `Pagina ${this.page} · quaderno ${this.note}`;
    return el;
  }
}

export const refreshMarkers = StateEffect.define<null>();

function build(state: EditorState, show: boolean): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.length > 120 || !line.text.includes("neopen:testo")) continue;
    const m = line.text.match(MARKER);
    if (!m) continue;
    if (show) {
      if (!m[1] && m[2]) {
        b.add(line.from, line.from, Decoration.widget({ widget: new PageLabel(m[4], m[5]), side: -1, block: true }));
      }
      continue;
    }
    // nasconde la riga intera, compreso l'a capo (se non è l'ultima riga)
    const to = i < doc.lines ? doc.line(i + 1).from : line.to;
    const from = i < doc.lines ? line.from : Math.max(0, line.from - 1);
    if (to > from) b.add(from, to, Decoration.replace({ block: true }));
  }
  return b.finish();
}

/** Estensione per l'editor; `isShown` legge l'impostazione corrente. */
export function markersExtension(isShown: () => boolean) {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, isShown()),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(refreshMarkers))) return build(tr.state, isShown());
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
