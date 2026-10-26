// Pannello laterale "Neo Pen": stato della penna e della sincronizzazione, ultima pagina letta, registro.

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type NeoPenPlugin from "../main";
import { strokeBounds } from "../render/svg";
import { PageKey, PenStatus, Stroke, pageId, sameKey } from "../types";

export const LIVE_VIEW = "neopen-live";

export class LiveView extends ItemView {
  private statusEl!: HTMLElement;
  private pageEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private logEl!: HTMLElement;
  private syncBtn!: HTMLButtonElement;
  private memoryBtn!: HTMLButtonElement;
  private progressEl!: HTMLElement;

  private currentKey: PageKey | null = null;
  private liveStroke: number[] = [];
  private raf = 0;
  private unsub: (() => void)[] = [];
  private resizeObs: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: NeoPenPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return LIVE_VIEW;
  }
  getDisplayText(): string {
    return "Neo Pen";
  }
  getIcon(): string {
    return "pen-line";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("neopen-view");

    const head = root.createDiv("neopen-head");
    this.statusEl = head.createDiv("neopen-status");
    const actions = head.createDiv("neopen-actions");
    this.syncBtn = actions.createEl("button", { cls: "mod-cta", text: "Sincronizza ora" });
    this.syncBtn.onclick = () => void this.plugin.syncNow();
    this.memoryBtn = actions.createEl("button", { text: "Memoria della penna" });
    this.memoryBtn.onclick = () => void this.plugin.openMemory();
    const tr = actions.createEl("button", { attr: { "aria-label": "Trascrivi il testo nuovo della pagina" } });
    setIcon(tr, "type");
    tr.onclick = () => void this.plugin.transcribeCurrent("new");
    const diag = actions.createEl("button", { attr: { "aria-label": "Diagnostica Bluetooth" } });
    setIcon(diag, "stethoscope");
    diag.onclick = () => this.plugin.runDiagnostics();

    this.progressEl = root.createDiv("neopen-progress");
    this.pageEl = root.createDiv("neopen-page-label");
    const wrap = root.createDiv("neopen-canvas-wrap");
    this.canvas = wrap.createEl("canvas", { cls: "neopen-canvas" });
    this.resizeObs = new ResizeObserver(() => this.requestDraw());
    this.resizeObs.observe(wrap);

    root.createDiv({ cls: "neopen-log-title", text: "Registro" });
    this.logEl = root.createDiv("neopen-log");
    for (const line of this.plugin.logLines) this.appendLog(line);

    const pen = this.plugin.pen;
    this.unsub.push(
      pen.on("status", (s) => this.renderStatus(s)),
      pen.on("dot", (d) => {
        if (!sameKey(this.currentKey, d.key)) this.showPage(d.key);
        if (d.type === 2) {
          this.liveStroke = []; // il tratto completo arriva dal salvataggio
        } else {
          if (d.type === 0) this.liveStroke = [];
          this.liveStroke.push(d.x, d.y, d.f);
        }
        this.requestDraw();
      }),
      this.plugin.onSync((info) => this.renderSync(info.message, info.running)),
      this.plugin.onLog((line) => this.appendLog(line)),
      this.plugin.onPageUpdated((page) => {
        if (!this.currentKey || sameKey(this.currentKey, page.key)) {
          if (!this.currentKey) this.showPage(page.key);
          else this.requestDraw();
        }
      })
    );
    this.renderStatus(pen.getStatus());
    this.renderSync(this.plugin.syncInfo.message, this.plugin.syncInfo.running);
  }

  private renderSync(message: string, running: boolean): void {
    this.progressEl.setText(message);
    this.syncBtn.disabled = running;
    this.syncBtn.setText(running ? "Sincronizzo…" : "Sincronizza ora");
  }

  async onClose(): Promise<void> {
    this.unsub.forEach((u) => u());
    this.unsub = [];
    this.resizeObs?.disconnect();
    cancelAnimationFrame(this.raf);
  }

  private renderStatus(s: PenStatus): void {
    const labels: Record<string, string> = {
      disconnesso: "Penna scollegata",
      ricerca: "Cerco la penna…",
      connessione: "Mi collego…",
      connesso: "Collegata",
      scaricamento: "Leggo la memoria…",
    };
    let text = labels[s.state] ?? s.state;
    if (s.state === "disconnesso") {
      text += this.plugin.settings.autoSync
        ? ` · si collega da sola quando la accendi`
        : " · premi «Sincronizza ora»";
    }
    if (s.name && s.state !== "disconnesso") text += ` · ${s.name}`;
    if (s.battery != null) text += ` · 🔋 ${s.battery}%`;
    if (s.usedMemory != null) text += ` · memoria ${s.usedMemory}%`;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-connected", s.state === "connesso" || s.state === "scaricamento");
  }

  private showPage(key: PageKey): void {
    this.currentKey = key;
    this.liveStroke = [];
    this.pageEl.setText(`Quaderno ${key.note} · pagina ${key.page}  (${pageId(key)})`);
    void this.plugin.store.load(key).then(() => this.requestDraw());
  }

  private appendLog(line: string): void {
    if (!this.logEl) return;
    const el = this.logEl.createDiv({ cls: "neopen-log-line", text: line });
    while (this.logEl.childElementCount > 200) this.logEl.firstElementChild?.remove();
    el.scrollIntoView({ block: "nearest" });
  }

  private requestDraw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const canvas = this.canvas;
    const wrap = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    canvas.width = Math.max(1, cssW * dpr);
    canvas.height = Math.max(1, cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const page = this.currentKey ? this.plugin.store.peek(this.currentKey) : undefined;
    const strokes: Stroke[] = [...(page?.strokes ?? [])];
    if (this.liveStroke.length) strokes.push({ t: 0, tip: 0, color: 0, pts: this.liveStroke });

    if (!strokes.length) {
      ctx.fillStyle = getComputedStyle(this.contentEl).getPropertyValue("--text-faint") || "#999";
      ctx.font = "13px var(--font-interface)";
      ctx.textAlign = "center";
      ctx.fillText(
        this.currentKey ? "Pagina vuota" : "Qui compare l'ultima pagina letta dalla penna",
        cssW / 2,
        cssH / 2
      );
      return;
    }

    // Il foglio parte dall'angolo della pagina Ncode (0,0), così la scritta compare
    // nella posizione reale. Dimensione: almeno A5 (≈ 62 × 88 unità), allargata se
    // scrivi oltre. Poi si ingrandisce per riempire il pannello.
    const b = strokeBounds(strokes)!;
    const bw = Math.max(b.maxX + 3, 62);
    const bh = Math.max(b.maxY + 3, bw * 1.42);
    const pad = 12;
    const scale = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh);
    const ox = pad + ((cssW - pad * 2) - bw * scale) / 2; // centrato orizzontalmente
    const oy = pad;

    // foglio
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    const pw = bw * scale,
      ph = bh * scale;
    ctx.beginPath();
    ctx.roundRect?.(ox - 4, oy - 4, pw + 8, ph + 8, 6);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "#1f2328";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const maxF = this.plugin.pen.getStatus().maxForce || 1023;
    for (const s of strokes) {
      if (s.tip === 1 || s.pts.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < s.pts.length; i += 3) {
        const x = s.pts[i] * scale + ox;
        const y = s.pts[i + 1] * scale + oy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const f = s.pts[2] / maxF;
      ctx.lineWidth = Math.max(0.8, 0.22 * scale * (0.6 + 0.8 * Math.min(1, f)));
      ctx.stroke();
    }
  }
}
