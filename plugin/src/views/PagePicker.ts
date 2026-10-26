// Quando la nota aperta contiene più pagine del quaderno: scegli quale ritrascrivere (o tutte).

import { App, SuggestModal } from "obsidian";
import { PageKey } from "../types";

interface Choice {
  label: string;
  keys: PageKey[];
}

export class PagePicker extends SuggestModal<Choice> {
  constructor(app: App, private pages: PageKey[], private onPick: (keys: PageKey[]) => void) {
    super(app);
    this.setPlaceholder("Quale pagina vuoi ritrascrivere?");
  }

  getSuggestions(query: string): Choice[] {
    const list: Choice[] = this.pages.map((k) => ({ label: `Pagina ${k.page} (quaderno ${k.note})`, keys: [k] }));
    if (this.pages.length > 1) list.push({ label: `Tutte le pagine di questa nota (${this.pages.map((k) => k.page).join(", ")})`, keys: this.pages });
    const q = query.trim().toLowerCase();
    return q ? list.filter((c) => c.label.toLowerCase().includes(q)) : list;
  }

  renderSuggestion(c: Choice, el: HTMLElement): void {
    el.setText(c.label);
  }

  onChooseSuggestion(c: Choice): void {
    this.onPick(c.keys);
  }
}
