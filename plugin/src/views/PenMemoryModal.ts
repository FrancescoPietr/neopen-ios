// Finestra "Memoria della penna": elenca le pagine salvate nella penna (l'archivio),
// con anteprima e stato, e ti fa scegliere cosa recuperare in Obsidian o cancellare dalla penna.
// Nulla viene cancellato senza una conferma esplicita.

import { App, Modal, Notice } from "obsidian";
import { PageKey, pageId } from "../types";

export interface MemoryItem {
  key: PageKey;
  /** Immagine già presente nel vault (anteprima), se c'è. */
  thumb: string | null;
  /** Nome della nota in cui finisce oggi la pagina, o null se non c'è (più). */
  noteName: string | null;
  /** Mai letta dal plugin. */
  unseen: boolean;
}

export class PenMemoryModal extends Modal {
  private selected = new Set<string>();
  private busy = false;

  constructor(
    app: App,
    private items: MemoryItem[],
    private usedMemory: number | undefined,
    private actions: {
      recover: (keys: PageKey[]) => Promise<void>;
      remove: (keys: PageKey[]) => Promise<number>;
      closed: () => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("neopen-recover-modal");
    this.titleEl.setText("Neo Pen · Memoria della penna");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const missing = this.items.filter((i) => !i.noteName);
    const mem = this.usedMemory != null ? ` · memoria usata ${this.usedMemory}%` : "";
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `${this.items.length} pagine nella penna, ${missing.length} senza nota in Obsidian${mem}. ` +
        "Mentre questa finestra è aperta la penna resta collegata: non scriverci finché non la chiudi.",
    });
    if ((this.usedMemory ?? 0) >= 80) {
      contentEl.createEl("p", {
        cls: "neopen-warning",
        text: "La memoria della penna è quasi piena: cancella le pagine che non ti servono più.",
      });
    }
    if (!this.items.length) {
      contentEl.createEl("p", { text: "La memoria della penna è vuota." });
      return;
    }

    const tools = contentEl.createDiv("neopen-recover-tools");
    const selMissing = tools.createEl("button", { text: "Seleziona quelle senza nota" });
    const selAll = tools.createEl("button", { text: "Seleziona tutto" });
    const selNone = tools.createEl("button", { text: "Deseleziona tutto" });

    const list = contentEl.createDiv("neopen-recover-list");
    const boxes = new Map<string, HTMLInputElement>();
    for (const it of this.items) {
      const id = pageId(it.key);
      const row = list.createEl("label", { cls: "neopen-recover-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = this.selected.has(id);
      boxes.set(id, cb);
      cb.onchange = () => {
        if (cb.checked) this.selected.add(id);
        else this.selected.delete(id);
        update();
      };
      const thumb = row.createDiv("neopen-recover-thumb");
      if (it.thumb) thumb.createEl("img", { attr: { src: it.thumb } });
      else thumb.createDiv({ cls: "neopen-recover-nothumb", text: "senza anteprima" });
      const info = row.createDiv("neopen-recover-info");
      info.createDiv({ cls: "neopen-recover-title", text: `Quaderno ${it.key.note} · pagina ${it.key.page}` });
      info.createDiv({
        cls: "neopen-recover-status" + (it.noteName ? "" : " is-missing"),
        text: it.noteName
          ? `Nella nota «${it.noteName}»`
          : it.unseen
            ? "Mai letta dal plugin"
            : "Senza nota (cancellata?)",
      });
    }

    const footer = contentEl.createDiv("neopen-recover-footer");
    const del = footer.createEl("button", { cls: "mod-warning" });
    const go = footer.createEl("button", { cls: "mod-cta" });
    let confirmDelete = false;
    const update = () => {
      const n = this.selected.size;
      go.setText(n ? `Recupera ${n} in Obsidian` : "Recupera in Obsidian");
      del.setText(confirmDelete ? `Conferma: cancella ${n} pagine dalla penna` : n ? `Cancella ${n} dalla penna` : "Cancella dalla penna");
      go.disabled = del.disabled = n === 0 || this.busy;
    };
    update();

    const pick = (filter: (i: MemoryItem) => boolean) => {
      this.selected.clear();
      for (const it of this.items.filter(filter)) this.selected.add(pageId(it.key));
      boxes.forEach((b, id) => (b.checked = this.selected.has(id)));
      confirmDelete = false;
      update();
    };
    selMissing.onclick = () => pick((i) => !i.noteName);
    selAll.onclick = () => pick(() => true);
    selNone.onclick = () => pick(() => false);

    const chosen = () => this.items.filter((i) => this.selected.has(pageId(i.key))).map((i) => i.key);
    go.onclick = async () => {
      const keys = chosen();
      if (!keys.length) return;
      this.busy = true;
      update();
      go.setText("Recupero…");
      try {
        await this.actions.recover(keys);
        new Notice(`Neo Pen: recuperate ${keys.length} pagine.`);
        this.close();
      } catch (e) {
        new Notice(`Neo Pen: recupero non riuscito. ${(e as Error)?.message ?? e}`);
        this.busy = false;
        update();
      }
    };
    del.onclick = async () => {
      const keys = chosen();
      if (!keys.length) return;
      if (!confirmDelete) {
        confirmDelete = true; // secondo clic per confermare: la cancellazione non si può annullare
        update();
        return;
      }
      this.busy = true;
      update();
      del.setText("Cancello…");
      try {
        const n = await this.actions.remove(keys);
        new Notice(`Neo Pen: cancellate ${n} pagine dalla penna.`);
        const gone = new Set(keys.map(pageId));
        this.items = this.items.filter((i) => !gone.has(pageId(i.key)));
        this.selected.clear();
      } catch (e) {
        new Notice(`Neo Pen: cancellazione non riuscita. ${(e as Error)?.message ?? e}`);
      }
      this.busy = false;
      this.render();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    this.actions.closed();
  }
}
