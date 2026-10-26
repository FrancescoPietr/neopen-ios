// Fase 0: verifica cosa permette Obsidian su questo computer.

import { App, Modal, Notice, Platform, apiVersion } from "obsidian";

export interface DiagResult {
  lines: string[];
  ok: boolean;
}

export async function collectDiagnostics(chooserAvailable: boolean): Promise<DiagResult> {
  const lines: string[] = [];
  const proc = (window as any).process;
  const electron = proc?.versions?.electron;
  const chrome = proc?.versions?.chrome;
  lines.push(`Piattaforma: ${Platform.isMobile ? "mobile" : "desktop"} · ${proc?.platform ?? navigator.platform}`);
  if (electron) lines.push(`Electron ${electron} · Chromium ${chrome}`);
  lines.push(`Obsidian API: ${apiVersion}`);

  const bt = (navigator as any).bluetooth;
  lines.push(`navigator.bluetooth: ${bt ? "presente ✅" : "assente ❌"}`);
  let ok = !!bt;
  if (bt?.getAvailability) {
    try {
      const avail = await bt.getAvailability();
      lines.push(`Adattatore Bluetooth disponibile: ${avail ? "sì ✅" : "no ❌ (Bluetooth spento o assente?)"}`);
      ok = ok && avail;
    } catch (e) {
      lines.push(`getAvailability() errore: ${String(e)}`);
    }
  }
  lines.push(`Gestore di scelta dispositivo (Electron remote): ${chooserAvailable ? "installato ✅" : "non disponibile ⚠️"}`);
  if (!ok) {
    lines.push("");
    lines.push("➡️ Web Bluetooth non è utilizzabile qui: servirà il piano B (programma di supporto).");
  } else {
    lines.push("");
    lines.push("➡️ Premi «Prova ricerca penna»: accendi la penna e chiudi Neo Studio sul telefono.");
  }
  return { lines, ok };
}

export class DiagnosticsModal extends Modal {
  private pre!: HTMLElement;

  constructor(
    app: App,
    private initial: DiagResult,
    private tryConnect: () => Promise<void>,
    private getLog: () => string[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Neo Pen · Diagnostica Bluetooth");
    this.pre = this.contentEl.createEl("pre", { cls: "neopen-diag" });
    this.render();
    const row = this.contentEl.createDiv("neopen-diag-actions");
    const tryBtn = row.createEl("button", { text: "Prova ricerca penna", cls: "mod-cta" });
    tryBtn.disabled = !this.initial.ok;
    tryBtn.onclick = async () => {
      tryBtn.disabled = true;
      try {
        await this.tryConnect();
        this.initial.lines.push("", "✅ Connessione riuscita! Il Bluetooth funziona dentro Obsidian.");
      } catch (e) {
        this.initial.lines.push("", `❌ ${(e as Error)?.message ?? e}`);
      }
      this.render();
      tryBtn.disabled = false;
    };
    const copy = row.createEl("button", { text: "Copia risultato" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(this.text());
      new Notice("Risultato copiato");
    };
  }

  private text(): string {
    const log = this.getLog().slice(-30);
    return [...this.initial.lines, "", "— Registro —", ...log].join("\n");
  }

  private render(): void {
    this.pre.setText(this.text());
  }
}
