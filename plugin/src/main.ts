// Neo Pen per Obsidian: la memoria della penna è l'archivio; il plugin si collega quando
// la penna si accende, legge le pagine cambiate, trascrive con Claude e si scollega.

import { Modal, Notice, Platform, Plugin, Setting, TFile, TFolder } from "obsidian";
import { NoteRouter } from "./notes/NoteRouter";
import { markersExtension, refreshMarkers } from "./editor/markers";
import type { EditorView } from "@codemirror/view";
import { DiagnosticsModal, collectDiagnostics } from "./diagnostics";
import { Emitter } from "./events";
import { ChooserHandle, installElectronChooser, withUserGesture } from "./pen/electronChooser";
import { PenConnection } from "./pen/PenConnection";
import { PenWatcher } from "./pen/PenWatcher";
import { CalendarSync } from "./calendar/CalendarSync";
import { callPhone, callRelay, RelayPage } from "./calendar/GoogleCalendar";
import { DEFAULT_SETTINGS, NeoPenSettingTab, NeoPenSettings } from "./settings";
import { PageStore } from "./store/PageStore";
import { Transcriber, inlineTags } from "./transcribe/Transcriber";
import { PageData, PageKey, pageId } from "./types";
import { LIVE_VIEW, LiveView } from "./views/LiveView";
import { MemoryItem, PenMemoryModal } from "./views/PenMemoryModal";
import { registerDrawingBlocks } from "./views/drawingBlock";
import { besideSizesField } from "./editor/besideSizes";
import { DRAWING_BLOCK, formatDrawingBlock, labelsToLines, parseDrawingBlock, splitLegacyDrawing } from "./transcribe/drawings";
import { PageImageModal } from "./views/PageImageModal";
import { PagePicker } from "./views/PagePicker";

type PluginEvents = { log: string; page: PageData; sync: SyncInfo };

export interface SyncInfo {
  /** "in corso" mentre legge la penna. */
  running: boolean;
  last: number;
  message: string;
}

export default class NeoPenPlugin extends Plugin {
  settings!: NeoPenSettings;
  pen!: PenConnection;
  store!: PageStore;
  transcriber!: Transcriber;
  router!: NoteRouter;
  watcher!: PenWatcher;
  calendar!: CalendarSync;
  /** Ultima pagina su cui hai scritto (per i comandi "pagina corrente"). */
  lastKey: PageKey | null = null;
  logLines: string[] = [];
  syncInfo: SyncInfo = { running: false, last: 0, message: "" };
  private bus = new Emitter<PluginEvents>();
  private chooser!: ChooserHandle;
  private statusBar!: HTMLElement;
  /** Operazioni sulla penna in corso (sincronizzazione, finestra memoria…). */
  private penBusy = 0;
  private warnedLive = false;
  private autoFailures = 0;
  private needsIndexImport = false;
  private needsCalendarRepair = false;
  private relayBusy = false;
  private relaySeen = new Map<string, number>();
  private relayFailed = "";
  /** L'app del telefono trascrive le pagine lei (visto nello script). */
  private phoneTranscribes = false;
  private needsDrawingTidy = false;
  private calendarHandedOver = false;
  /** v0.13: le note vanno nella cartella del quaderno (dentro "Me"), senza data nel nome: cartella di prima. */
  private notebookMoveFrom = "";
  /** v0.14: disegno della pagina in un riquadro chiuso e #tag del testo nelle proprietà, anche nelle note vecchie. */
  private needsTidyV14 = false;
  private needsDrawingBlocks = false;
  private hideStyle: HTMLStyleElement | null = null;
  private visTimer = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.chooser = Platform.isDesktopApp
      ? installElectronChooser((m) => this.log(m))
      : { available: false, cancel() {}, setQuiet() {}, dispose() {} };

    this.pen = new PenConnection(this.chooser, Platform.isDesktopApp ? withUserGesture : undefined);
    this.pen.setSdkDebug(this.settings.sdkDebug);

    this.store = new PageStore(
      this.app,
      () => this.settings,
      (m) => this.log(m),
      (page) => {
        this.lastKey = page.key;
        this.bus.emit("page", page);
      },
      async (page) => {
        // Senza trascrizione automatica la nota si crea subito (nota di base).
        // Con la trascrizione invece si aspetta il primo testo: il tag in cima decide il tipo di nota.
        const transcribing = !!this.settings.apiKey && this.settings.autoTranscribe;
        if (this.settings.createNotes && !transcribing) {
          await this.router.ensure(page.key, { created: page.created });
        }
      },
      (id) => (this.router ? this.router.imageGroup(id) : [id]),
      () => this.settings.pageIndex,
      () => this.saveSettings()
    );

    this.router = new NoteRouter(
      this.app,
      () => this.settings,
      () => this.saveSettings(),
      (id) => this.store.svgPath(id),
      (m) => this.log(m),
      (rootId) => void this.store.writeGroup(rootId)
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.router.onRename(file, oldPath);
        else if (file instanceof TFolder) {
          this.router.onFolderRename(file, oldPath);
          this.scheduleVisibility();
        }
      })
    );
    // una cartella nuova in cima al vault: va nascosta anche lei
    this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFolder && this.scheduleVisibility()));
    this.registerEvent(this.app.vault.on("delete", (f) => f instanceof TFolder && this.scheduleVisibility()));

    this.transcriber = new Transcriber(
      this.app,
      this.store,
      this.router,
      () => ({
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        auto: this.settings.autoTranscribe,
        idleSeconds: this.settings.idleSeconds,
        vocabulary: this.settings.vocabulary,
        blacklist: this.settings.blacklist ?? "",
        quality: this.settings.quality,
        rootFolder: this.settings.rootFolder,
        handwritingRefs: this.settings.handwritingRefs ?? [],
        handwritingEnabled: this.settings.handwritingEnabled,
        handwritingMax: this.settings.handwritingMax,
        handwritingLang: this.settings.handwritingLang,
        lineRows: (this.settings.lineRows = this.settings.lineRows ?? {}),
      }),
      (m) => this.log(m),
      (m) => new Notice(m, 8000),
      (dollars) => {
        const month = new Date().toISOString().slice(0, 7);
        if (this.settings.spendMonth !== month) {
          this.settings.spendMonth = month;
          this.settings.spendTotal = 0;
        }
        this.settings.spendTotal += dollars;
        void this.saveSettings();
      },
      () => (this.settings.debugDump ? this.debugDir() : ""),
      async (ids) => {
        this.settings.handwritingRefs = ids;
        await this.saveSettings();
      }
    );

    this.calendar = new CalendarSync(
      this.app,
      () => this.settings,
      () => this.saveSettings(),
      // le copie nel cestino non vanno mai nel calendario
      (file, ids) => (this.router.inBin(file.path) ? [] : this.router.calendarScope(file, ids, this.settings.calendarEverywhere)),
      (file) => this.router.dailyDate(file),
      (m) => this.log(m)
    );
    // ogni modifica di una nota con task scritti a mano (trascrizione o spunta in Obsidian) aggiorna il calendario
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        // sull'iPhone il plugin è passivo: calendario e attività li aggiorna il PC (niente doppioni)
        if (Platform.isMobile || !this.settings.calendarEnabled || this.router.inBin(file.path)) return;
        const known = this.settings.calendarEverywhere || Object.values(this.settings.pageNotes).some((r) => r.path === file.path);
        if (known) this.calendar.schedule(file);
      })
    );

    const unbinned = Platform.isMobile ? 0 : this.router.forgetBinned();
    if (unbinned) {
      await this.saveSettings();
      this.log(`Scollegate ${unbinned} pagine che puntavano a note nel cestino: alla prossima trascrizione avranno la loro nota.`);
    }

    if (this.needsIndexImport && !Platform.isMobile) {
      // dalle versioni con l'archivio _dati: ricorda fin dove ogni pagina era già trascritta
      const n = await this.store.importOldIndex();
      if (n) this.log(`Importato da _dati lo stato di ${n} pagine già trascritte (la cartella _dati non serve più).`);
    }

    // forza massima della penna ricordata (anche sull'iPhone, dove la penna non si collega)
    if (this.settings.penMaxForce > 0) {
      this.store.setMaxForce(this.settings.penMaxForce);
      this.transcriber.setMaxForce(this.settings.penMaxForce);
    }

    // collega gli eventi della penna
    this.pen.on("log", (m) => this.log(m));
    this.pen.on("status", (s) => {
      this.store.setMaxForce(s.maxForce);
      this.transcriber.setMaxForce(s.maxForce);
      if (s.maxForce && s.maxForce !== this.settings.penMaxForce) {
        this.settings.penMaxForce = s.maxForce;
        void this.saveSettings();
      }
      this.updateStatusBar();
      if (s.state === "disconnesso") {
        void this.store.flush();
        this.transcriber.flushTimers();
      }
    });
    // Tratti in tempo reale: la penna li manda solo se chiesti, ma per sicurezza li gestiamo
    // (es. se scrivi mentre è collegata per la sincronizzazione): non restano nella penna.
    this.pen.on("stroke", ({ key, stroke, source }) => {
      this.lastKey = key;
      if (!this.warnedLive) {
        this.warnedLive = true;
        this.log("La penna ha mandato tratti in tempo reale mentre era collegata: quelli non restano nella sua memoria (li tengo io finché Obsidian è aperto).");
      }
      void this.store
        .addStroke(key, stroke)
        .then((added) => {
          if (added) this.transcriber.onStroke(key, source);
        })
        .catch(() => undefined);
    });
    this.pen.on("offlineProgress", (p) => this.setSync({ message: `Leggo quaderno ${p.note}, pagina ${p.page}… ${p.percent}%` }));
    this.pen.on("passwordRequest", (p) => this.askPassword(p.retry, p.reset));

    this.watcher = new PenWatcher({
      enabled: () => this.settings.autoSync && Platform.isDesktopApp && !!(navigator as any).bluetooth,
      intervalMs: () => Math.max(2, this.settings.syncEveryMinutes || 5) * 60_000,
      busy: () => this.penBusy > 0 || this.pen.getStatus().state !== "disconnesso",
      attempt: () => this.syncNow({ auto: true }),
    });
    registerDrawingBlocks(this);
    this.app.workspace.onLayoutReady(() => {
      this.applyVisibility();
      this.watcher.start();
      if (Platform.isMobile) return; // sull'iPhone niente lavori di manutenzione: li fa il PC
      if (this.calendarHandedOver) {
        this.log("Calendario e attività dei task scritti a penna ora li fa l'app NeoTransfer sul telefono: il plugin non li manda più a Google Calendar / Todoist (si riattiva in Impostazioni → Neo Pen).");
        new Notice("Neo Pen: calendario e attività ora li fa l'app sul telefono.", 8000);
      }
      void this.router.repairDailyNames().then(() => this.router.repairPages());
      if (this.needsDrawingTidy) void this.tidyAllDrawings();
      void this.router.syncTitlesFromNames().then(async () => {
        if (this.notebookMoveFrom) {
          // il primo quaderno: l'hai iniziato il 17/10/2026 (lo dici tu; il primo tratto in memoria è della sera prima)
          await this.router.moveNotesToNotebooks(this.notebookMoveFrom, { "3_27_746": "2026-10-17" });
          this.notebookMoveFrom = "";
        }
        if (this.needsTidyV14) {
          this.needsTidyV14 = false;
          await this.tidyAllDrawings();
          await this.tagOldNotes();
        }
        if (this.needsDrawingBlocks) {
          this.needsDrawingBlocks = false;
          await this.convertOldDrawings();
        }
      });
      if (this.needsCalendarRepair) {
        this.log("Calendario: rimetto gli eventi nel fuso orario di questo dispositivo…");
        void this.syncCalendarAll();
      }
    });
    this.register(() => this.watcher.stop());

    // pagine mandate dall'iPhone tramite lo script Google: le prende chi ha Obsidian aperto (PC o iPhone)
    {
      let last = 0;
      const tick = () => {
        const every = Math.max(1, this.settings.relayMinutes || 2) * 60_000;
        if (Date.now() - last >= every - 2000) {
          last = Date.now();
          void this.pullRelay();
        }
      };
      this.registerInterval(window.setInterval(tick, 15_000));
      this.app.workspace.onLayoutReady(() => window.setTimeout(() => void this.pullRelay(), 8000));
      // sull'iPhone Obsidian dorme in background: quando torna in primo piano si controlla subito
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") window.setTimeout(() => void this.pullRelay(), 1500);
      });
    }

    this.registerEditorExtension(markersExtension(() => this.settings.showMarkers));
    this.registerEditorExtension(besideSizesField);

    // miniatura del disegno nella nota: clic → pagina intera.
    // Si reagisce alla PRESSIONE del tasto: in modifica Obsidian ridisegna l'immagine appena la premi
    // (per spostare il cursore su quella riga) e il "click" non arriverebbe più all'immagine.
    const isPageImg = (t: EventTarget | null): HTMLImageElement | null => {
      const img = (t as HTMLElement | null)?.closest?.("img") as HTMLImageElement | null;
      if (!img || img.closest(".neopen-image-modal") || !/_pagine(\/|%2F)/i.test(img.src)) return null;
      return img;
    };
    let opening = 0;
    const open = (ev: Event, img: HTMLImageElement) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (Date.now() - opening < 600) return; // pointerdown e mousedown dello stesso clic
      opening = Date.now();
      new PageImageModal(this.app, img.src).open();
    };
    // pointerdown arriva per primo: se Obsidian lo blocca, mousedown e click non partono nemmeno
    for (const type of ["pointerdown", "mousedown"] as const) {
      this.registerDomEvent(
        document,
        type,
        (ev: MouseEvent) => {
          if (ev.button !== 0) return;
          const img = isPageImg(ev.target);
          if (img) open(ev, img);
        },
        { capture: true }
      );
    }
    // il resto del clic (rilascio, clic) non deve fare altro: niente cursore spostato, niente file aperto
    for (const type of ["pointerup", "mouseup", "click"] as const) {
      this.registerDomEvent(
        document,
        type,
        (ev: MouseEvent) => {
          if (isPageImg(ev.target) || (type === "click" && Date.now() - opening < 800)) {
            ev.preventDefault();
            ev.stopPropagation();
          }
        },
        { capture: true }
      );
    }

    this.registerView(LIVE_VIEW, (leaf) => new LiveView(leaf, this));
    this.addSettingTab(new NeoPenSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("neopen-statusbar");
    this.statusBar.onclick = () => this.openLiveView();
    this.updateStatusBar();

    this.addRibbonIcon("pen-line", "Neo Pen", () => this.openLiveView());

    this.addCommand({ id: "open-live-view", name: "Apri pannello", callback: () => this.openLiveView() });
    this.addCommand({
      id: "toggle-other-folders",
      name: "Mostra/nascondi le altre cartelle in Esplora file",
      callback: async () => {
        this.settings.explorerOnlyNotes = !this.settings.explorerOnlyNotes;
        await this.saveSettings();
        this.applyVisibility();
        new Notice(this.settings.explorerOnlyNotes ? "Esplora file: solo la cartella note." : "Esplora file: tutte le cartelle.");
      },
    });
    this.addCommand({ id: "pull-iphone", name: "Leggi ora le pagine mandate dall'iPhone", callback: () => void this.pullRelay(true) });
    this.addCommand({ id: "sync-now", name: "Sincronizza ora con la penna", callback: () => void this.syncNow() });
    this.addCommand({ id: "pen-memory", name: "Memoria della penna (recupera o cancella pagine)", callback: () => void this.openMemory() });
    this.addCommand({ id: "diagnostics", name: "Diagnostica Bluetooth", callback: () => this.runDiagnostics() });
    this.addCommand({
      id: "transcribe-current",
      name: "Trascrivi il testo nuovo della pagina corrente",
      callback: () => void this.transcribeCurrent("new"),
    });
    this.addCommand({
      id: "retranscribe-current",
      name: "Ritrascrivi da capo la pagina corrente",
      callback: () => void this.transcribeCurrent("all"),
    });
    this.addCommand({
      id: "calendar-note",
      name: "Aggiorna il calendario dai task di questa nota",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return;
        void this.calendar
          .syncFile(f)
          .then((n) => new Notice(n ? `Neo Pen: calendario aggiornato (${n}).` : "Neo Pen: calendario già in pari."))
          .catch((e) => new Notice(`Neo Pen: ${(e as Error)?.message ?? e}`));
      },
    });
    this.addCommand({
      id: "restore-drawing",
      name: "Rimetti il disegno della pagina in questa nota",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return;
        const ids = Object.entries(this.settings.pageNotes)
          .filter(([, r]) => r.path === f.path)
          .map(([id]) => id.split("~")[0]);
        for (const id of new Set(ids)) {
          const [section, owner, note, page] = id.split("_").map(Number);
          const key = { section, owner, note, page };
          const seg = this.router.partsOf(key).find((n) => n.file.path === f.path);
          if (seg) {
            const ref = this.settings.pageNotes[seg.blockId];
            if (ref) ref.drawing = true;
            await this.router.ensureDrawing(seg, key);
          }
        }
        await this.saveSettings();
      },
    });
    this.addCommand({ id: "reread-all", name: "Rileggi tutto dalla penna e ridisegna", callback: () => void this.syncNow({ all: true }) });

    this.log(`Neo Pen ${this.manifest.version} caricato (${Platform.isMobile ? "mobile" : "desktop"}).`);
  }

  private scheduleVisibility(): void {
    window.clearTimeout(this.visTimer);
    this.visTimer = window.setTimeout(() => this.applyVisibility(), 500);
  }

  /** Cartelle in cima al vault da nascondere (solo quelle elencate nelle impostazioni, mai la cartella note). */
  private otherFolders(): string[] {
    const keep = (this.settings.notesFolder || "").split("/").filter(Boolean)[0] ?? "";
    const hide = new Set(this.settings.hiddenFolders ?? []);
    return this.app.vault
      .getRoot()
      .children.filter((f): f is TFolder => f instanceof TFolder && f.name !== keep && hide.has(f.name) && !f.name.startsWith("."))
      .map((f) => f.path);
  }

  /**
   * Solo la cartella note in vista: le altre cartelle si nascondono in Esplora file (si mostrano col comando)
   * e diventano "file esclusi" di Obsidian, così non compaiono nel grafo né nella ricerca.
   */
  applyVisibility(): void {
    const others = this.otherFolders();
    // Esplora file
    if (!this.hideStyle) {
      this.hideStyle = document.head.createEl("style", { attr: { id: "neopen-hide-folders" } });
      this.register(() => this.hideStyle?.remove());
    }
    const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    this.hideStyle.textContent = this.settings.explorerOnlyNotes
      ? others
          .map((p) => `.nav-folder:has(> .nav-folder-title[data-path="${esc(p)}"]), .nav-folder-title[data-path="${esc(p)}"] { display: none !important; }`)
          .join("\n")
      : "";
    // grafo e ricerca: "file esclusi" (Impostazioni → File e link). I filtri tuoi restano.
    if (Platform.isMobile) return;
    const vault = this.app.vault as unknown as { getConfig?: (k: string) => unknown; setConfig?: (k: string, v: unknown) => void };
    if (!vault.getConfig || !vault.setConfig) return;
    const cur = ((vault.getConfig("userIgnoreFilters") as string[] | null) ?? []).slice();
    const added = new Set(this.settings.ignoreAdded ?? []);
    const mine = cur.filter((f) => !added.has(f));
    const want = this.settings.excludeOthers ? others.map((p) => `${p}/`) : [];
    const next = [...mine, ...want.filter((w) => !mine.includes(w))];
    const same = next.length === cur.length && next.every((x, i) => x === cur[i]);
    const nowAdded = want.filter((w) => !mine.includes(w));
    if (!same) vault.setConfig("userIgnoreFilters", next);
    const prev = this.settings.ignoreAdded ?? [];
    if (prev.length !== nowAdded.length || prev.some((x, i) => x !== nowAdded[i])) {
      this.settings.ignoreAdded = nowAdded;
      void this.saveSettings();
    }
  }

  async onunload(): Promise<void> {
    this.watcher?.stop();
    this.pen?.disconnect();
    await this.store?.flush();
    this.chooser?.dispose();
    this.bus.clear();
  }

  // ---------------------------------------------------------------- log ed eventi

  log(msg: string): void {
    const t = new Date().toLocaleTimeString("it-IT");
    const line = `${t}  ${msg}`;
    this.logLines.push(line);
    if (this.logLines.length > 300) this.logLines.shift();
    console.log("[NeoPen]", msg);
    this.bus.emit("log", line);
    if (this.settings?.debugDump) {
      this.pendingLog.push(`${new Date().toLocaleString("sv-SE")}  ${msg}`);
      if (!this.logTimer) this.logTimer = window.setTimeout(() => void this.flushLogFile(), 1000);
    }
  }

  private pendingLog: string[] = [];
  private logTimer: number | null = null;

  debugDir(): string {
    return `${(this.settings.rootFolder || "NeoPen").replace(/\/+$/, "")}/_debug`;
  }

  /** Registro anche su file (solo con le copie di debug attive). */
  private async flushLogFile(): Promise<void> {
    this.logTimer = null;
    const lines = this.pendingLog.splice(0);
    if (!lines.length) return;
    try {
      const a = this.app.vault.adapter;
      const dir = this.debugDir();
      if (!(await a.exists(dir))) await a.mkdir(dir);
      await a.append(`${dir}/registro.log`, lines.join("\n") + "\n");
    } catch {
      /* il registro su file è solo un aiuto */
    }
  }

  onLog(fn: (line: string) => void): () => void {
    return this.bus.on("log", fn);
  }

  onPageUpdated(fn: (page: PageData) => void): () => void {
    return this.bus.on("page", fn);
  }

  // ---------------------------------------------------------------- azioni

  onSync(fn: (info: SyncInfo) => void): () => void {
    return this.bus.on("sync", fn);
  }

  private setSync(patch: Partial<SyncInfo>): void {
    this.syncInfo = { ...this.syncInfo, ...patch };
    this.bus.emit("sync", this.syncInfo);
  }

  private mobileGuard(quiet = false): boolean {
    if (Platform.isMobile) {
      if (!quiet) new Notice("Su iPhone la penna si collega tramite il connettore web (fase 5). Per ora usa Obsidian sul PC.");
      return true;
    }
    return false;
  }

  /** Esegue un'operazione con la penna collegata (si collega se serve), una alla volta. */
  private withPen<T>(fn: () => Promise<T>, opts: { auto?: boolean; keepConnected?: boolean } = {}): Promise<T> {
    this.penBusy++;
    return this.pen
      .exclusive(async () => {
        if (!this.pen.isConnected) {
          // tentativi automatici: in silenzio; ogni tanto una ricerca nuova se la penna "ricordata" non risponde
          const reuse = !!opts.auto && this.pen.hasKnownDevice && this.autoFailures % 3 !== 2;
          await this.pen.connect(opts.auto ? { quiet: true, reuse, scanMs: 6000 } : {});
        }
        try {
          return await fn();
        } finally {
          if (!opts.keepConnected) this.pen.disconnect();
        }
      })
      .finally(() => this.penBusy--);
  }

  /** Prende dallo script Google le pagine lasciate dall'iPhone e le trascrive come se arrivassero dalla penna. */
  async pullRelay(verbose = false): Promise<number> {
    const st = this.settings;
    if (!st.relayEnabled || !st.calendarUrl || this.relayBusy) {
      if (verbose && !st.calendarUrl) new Notice("Neo Pen: manca l'indirizzo dello script (Impostazioni → Calendario).");
      return 0;
    }
    this.relayBusy = true;
    try {
      // sull'iPhone lo stato si rilegge dal disco: l'app NeoTransfer può aver trascritto pagine mentre Obsidian era chiuso
      if (Platform.isMobile) await this.loadSettings();
      const list = await callRelay(st.calendarUrl, st.calendarSecret, { action: "list", device: Platform.isMobile ? "mobile" : "pc" });
      this.lastRelayPull = Date.now();
      if (Platform.isMobile) {
        // sull'iPhone si trascrive solo se il PC è spento (non si fa vivo da 10 minuti): così un solo dispositivo
        // alla volta scrive note e impostazioni
        const pcSeen = Number(list.pcSeen) || 0;
        const away = pcSeen > 0 && Date.now() - pcSeen > 10 * 60_000;
        if (!away) {
          if (this.mobileWorking) this.log("Il PC è acceso: trascrive lui.");
          this.mobileWorking = false;
          if (verbose) new Notice(pcSeen ? "Neo Pen: il PC è acceso, trascrive lui." : "Neo Pen: aggiorna lo script Google per trascrivere dal telefono.");
          return 0;
        }
        if (!this.mobileWorking) this.log("Il PC è spento: trascrivo da qui.");
        this.mobileWorking = true;
      }
      // l'app NeoTransfer trascrive le pagine sul telefono (e lo dice allo script): qui non si rifanno, le note arrivano
      // già fatte con la sincronizzazione (due dispositivi che trascrivono la stessa pagina fanno doppioni)
      const phone = ((list.pages ?? []) as RelayPage[]).find((p) => p.id === "telefono");
      if (phone && Date.now() - Number(phone.count) < 3 * 86_400_000) {
        if (!this.phoneTranscribes) this.log("Le pagine le trascrive l'app sul telefono: Obsidian riceve le note già fatte.");
        this.phoneTranscribes = true;
        this.mobileWorking = false;
        if (verbose) new Notice("Neo Pen: le pagine le trascrive l'app sul telefono.");
        return 0;
      }
      this.phoneTranscribes = false;
      await this.phoneMaintenance();
      let pages = 0;
      let fresh = 0;
      for (const p of (list.pages ?? []) as RelayPage[]) {
        const [section, owner, note, page] = String(p.id).split("_").map(Number);
        if (![section, owner, note, page].every(Number.isFinite)) continue;
        const key: PageKey = { section, owner, note, page };
        if (this.relaySeen.get(p.id) === (p.updated ?? 0)) continue;
        if (!this.store.needsRelay(key, p.count)) {
          this.relaySeen.set(p.id, p.updated ?? 0);
          continue;
        }
        // c'è lavoro da fare: PC e iPhone non devono trascrivere insieme la stessa pagina
        if (!(await this.takeLease())) {
          if (verbose) new Notice("Neo Pen: un altro dispositivo sta già trascrivendo, riprovo tra poco.");
          return pages;
        }
        const got = await callRelay(st.calendarUrl, st.calendarSecret, { action: "get", id: p.id });
        const d = got.page as RelayPage;
        // una pagina letta vuota non deve mai sostituire quella buona
        if (!(d.strokes ?? []).length) {
          this.relaySeen.set(p.id, p.updated ?? 0);
          continue;
        }
        fresh += await this.store.setFromPen(key, d.count ?? p.count, (d.strokes ?? []) as any[], undefined, "relay");
        this.relaySeen.set(p.id, p.updated ?? 0);
        pages++;
      }
      this.relayFailed = "";
      if (pages) this.log(`Dall'iPhone: ${pages} pagine lette, ${fresh} tratti nuovi.`);
      if (fresh) this.transcriber.onOfflineDone();
      if (verbose) new Notice(pages ? `Neo Pen: ${pages} pagine dall'iPhone (${fresh} tratti nuovi).` : "Neo Pen: niente di nuovo dall'iPhone.");
      return pages;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (verbose) new Notice(`Neo Pen: ${msg}`, 10000);
      if (msg !== this.relayFailed) this.log(`Lettura dall'iPhone non riuscita: ${msg}`);
      this.relayFailed = msg;
      return 0;
    } finally {
      this.relayBusy = false;
    }
  }

  /** Sull'iPhone: il PC è spento e questo dispositivo trascrive (solo allora scrive le impostazioni). */
  private mobileWorking = false;
  private phoneConfigSent = "";
  private phoneOld = false;
  private phoneFailed = "";
  /** Da quando la pagina risulta trascritta oltre gli eventi del telefono (si aspetta che il calendario si allinei). */
  private phoneReadySince = new Map<string, number>();

  /**
   * Appuntamenti creati dall'app del telefono (PC spento): quando la pagina è trascritta qui, il calendario ha già gli
   * eventi della nota, quindi quelli del telefono si tolgono (niente doppioni). Il telefono riceve anche il calendario
   * e la durata degli eventi da usare.
   */
  private async phoneMaintenance(): Promise<void> {
    const st = this.settings;
    if (!st.calendarUrl || this.phoneOld || !st.calendarEnabled) return;
    try {
      const target = st.tasksTarget ?? (st.googleTasks === false ? "none" : "google");
      const config = {
        action: "config",
        calendarId: st.calendarId,
        minutes: st.eventMinutes,
        target,
        todoistToken: target === "todoist" ? st.todoistToken : "",
        todoistProject: st.todoistProject,
        tasksList: st.tasksList,
      };
      const cfg = JSON.stringify(config);
      if (cfg !== this.phoneConfigSent) {
        await callPhone(st.calendarUrl, st.calendarSecret, config);
        this.phoneConfigSent = cfg;
      }
      const list = await callPhone(st.calendarUrl, st.calendarSecret, { action: "list" });
      for (const [id, info] of Object.entries((list.pages ?? {}) as Record<string, { upTo: number; count: number }>)) {
        const [section, owner, note, page] = id.split("_").map(Number);
        if (![section, owner, note, page].every(Number.isFinite)) continue;
        const done = this.store.entry({ section, owner, note, page })?.done ?? 0;
        if (done < info.upTo) {
          this.phoneReadySince.delete(id);
          continue;
        }
        // trascritta: si lascia passare un giro, così gli eventi della nota sono già nel calendario
        const since = this.phoneReadySince.get(id);
        if (!since) {
          this.phoneReadySince.set(id, Date.now());
          continue;
        }
        if (Date.now() - since < 45_000) continue;
        const r = await callPhone(st.calendarUrl, st.calendarSecret, { action: "clear", page: id, upTo: done });
        this.phoneReadySince.delete(id);
        if (r.removed) this.log(`Pagina ${page}: ${r.removed} ${r.removed === 1 ? "elemento creato" : "eventi e attività creati"} dal telefono, sostituiti da quelli della nota.`);
      }
      this.phoneFailed = "";
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (msg === "vecchio") {
        this.phoneOld = true;
        this.log("Appuntamenti dal telefono: lo script Google è una versione vecchia. Impostazioni → Neo Pen → copia di nuovo lo script e ripubblicalo (Nuova versione).");
      } else if (msg !== this.phoneFailed) {
        this.phoneFailed = msg;
        this.log(`Appuntamenti dal telefono: ${msg}`);
      }
    }
  }

  /** Identificativo di questo dispositivo (resta nel browser/app, non nel vault). */
  private deviceId(): string {
    try {
      let id = window.localStorage.getItem("neopen-device");
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        window.localStorage.setItem("neopen-device", id);
      }
      return id;
    } catch {
      return "dev-" + (Platform.isMobile ? "m" : "d");
    }
  }

  /**
   * "Turno" di trascrizione: un file nel vault (sincronizzato da Obsidian Sync) dice quale dispositivo sta lavorando.
   * Gli altri aspettano che scada (5 minuti). Se il file non si legge o scrive, si lavora comunque.
   */
  private async takeLease(): Promise<boolean> {
    const path = "NeoPen/_turno.json";
    const me = this.deviceId();
    const a = this.app.vault.adapter;
    try {
      if (await a.exists(path)) {
        const cur = JSON.parse(await a.read(path));
        if (cur?.device && cur.device !== me && Number(cur.until) > Date.now()) return false;
      }
      if (!(await a.exists("NeoPen"))) await a.mkdir("NeoPen");
      await a.write(path, JSON.stringify({ device: me, until: Date.now() + 5 * 60_000 }));
    } catch (e) {
      this.log(`Turno di trascrizione non leggibile (${(e as Error)?.message ?? e}): vado avanti.`);
    }
    return true;
  }

  /** Un altro dispositivo ha cambiato le impostazioni (pagine trascritte, note…): si rileggono. */
  async onExternalSettingsChange(): Promise<void> {
    // Sul PC acceso le impostazioni giuste sono quelle in memoria: una copia arrivata da un altro dispositivo
    // (magari vecchia) non le sostituisce. Si rileggono solo se il PC è rimasto fermo a lungo (sospensione):
    // allora può averle aggiornate l'iPhone, che trascrive quando il PC è spento.
    if (!Platform.isMobile && Date.now() - this.lastRelayPull < 10 * 60_000) return;
    await this.loadSettings();
    this.applyVisibility();
  }

  private lastRelayPull = Date.now();

  /**
   * Pagina appena riletta dalla penna che ha anche tratti scritti con l'app dell'iPhone in tempo reale (la penna non
   * li ha in memoria): si riprende la copia dall'iPhone e si unisce, così il disegno non li perde.
   */
  private async fromPen(key: PageKey, count: number, strokes: any[], bytes?: number): Promise<number> {
    let fresh = await this.store.setFromPen(key, count, strokes, bytes);
    const st = this.settings;
    if (!this.store.hasRelay(key) || !st.relayEnabled || !st.calendarUrl) return fresh;
    try {
      const got = await callRelay(st.calendarUrl, st.calendarSecret, { action: "get", id: pageId(key) });
      const d = got?.page as RelayPage | undefined;
      if (d?.strokes?.length) fresh = await this.store.setFromPen(key, d.count ?? 0, d.strokes as any[], undefined, "relay");
    } catch (e) {
      this.log(`Pagina ${key.page}: non riesco a riprendere la copia dall'iPhone (${(e as Error)?.message ?? e}).`);
    }
    return fresh;
  }

  /** Nota con l'indirizzo e la chiave dello script, da copiare nella pagina dell'iPhone. */
  async writeIphoneNote(): Promise<void> {
    const st = this.settings;
    if (!st.calendarUrl) {
      new Notice("Neo Pen: prima inserisci l'indirizzo dello script (Impostazioni → Calendario).");
      return;
    }
    const dir = "NeoPen";
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => undefined);
    const path = `${dir}/Collegamento iPhone.md`;
    const body =
      "# Collegamento iPhone\n\nApri la pagina Neo Pen in Bluefy e copia qui sotto i due valori (tieni premuto sul testo → Copia).\n" +
      "Quando hai finito, **cancella questa nota**: contiene la chiave segreta.\n\n" +
      "Indirizzo dello script:\n\n```\n" + st.calendarUrl + "\n```\n\nChiave segreta:\n\n```\n" + st.calendarSecret + "\n```\n";
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modify(f, body);
    else await this.app.vault.create(path, body);
    new Notice("Neo Pen: nota creata in NeoPen/Collegamento iPhone. Sincronizza e aprila sull'iPhone.", 8000);
  }

  /**
   * Sincronizzazione: legge dalla penna le pagine cambiate (o tutte con `all`), aggiorna
   * i disegni, trascrive il testo nuovo e si scollega. Restituisce true se la penna c'era.
   */
  async syncNow(opts: { auto?: boolean; all?: boolean } = {}): Promise<boolean> {
    if (this.mobileGuard(opts.auto)) return false;
    if (!opts.auto && this.penBusy) {
      new Notice("Neo Pen: la penna è già impegnata, riprova tra poco.");
      return false;
    }
    const transcribing = !!this.settings.apiKey && this.settings.autoTranscribe;
    try {
      const res = await this.withPen(
        async () => {
          this.setSync({ running: true, message: "Leggo la memoria della penna…" });
          if (opts.auto) this.log("Penna accesa: sincronizzo…");
          const r = await this.pen.sync({
            shouldDownload: (key, count, bytes) =>
              !!opts.all || this.store.needsDownload(key, count, bytes) || (transcribing && !!this.store.entry(key)?.open),
            // per ridisegnare l'immagine unica di una nota servono tutte le sue pagine
            extra: (keys) => {
              const out: PageKey[] = [];
              for (const k of keys)
                for (const id of this.router.imageGroup(pageId(k))) {
                  const [section, owner, note, page] = id.split("_").map(Number);
                  const key = { section, owner, note, page };
                  if (!this.store.has(key)) out.push(key);
                }
              return out;
            },
          });
          let fresh = 0;
          for (const d of r.downloaded) fresh += await this.fromPen(d.key, d.count, d.strokes, d.bytes);
          return { ...r, fresh };
        },
        { auto: opts.auto }
      );
      this.autoFailures = 0;
      const time = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
      const mem = this.pen.getStatus().usedMemory;
      const summary =
        `${res.memory.length} pagine nella penna` +
        (res.downloaded.length ? `, ${res.downloaded.length} lette` : "") +
        (res.skipped ? `, ${res.skipped} invariate` : "") +
        (res.fresh ? `, ${res.fresh} tratti nuovi` : ", niente di nuovo") +
        (mem != null ? ` · memoria usata ${mem}%` : "");
      this.log(`Sincronizzata: ${summary}.`);
      if (mem != null && mem >= 80) new Notice(`Neo Pen: la memoria della penna è al ${mem}%. Apri «Memoria della penna» per liberarla.`, 10000);
      this.setSync({ running: false, last: Date.now(), message: `Sincronizzata alle ${time}: ${summary}` });
      this.watcher?.notifySynced();
      if (res.fresh) this.transcriber.onOfflineDone();
      return true;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.setSync({ running: false });
      if (opts.auto) {
        this.autoFailures++;
        // penna spenta o lontana: normale, niente messaggi. Se si era collegata, invece, lo diciamo.
        if (!/Ricerca fallita|non risponde|non ha autorizzato|disconnected|NetworkError|cancel/i.test(msg)) this.log(`Sincronizzazione automatica non riuscita: ${msg}`);
        if (/gesture|gesto/i.test(msg) && this.autoFailures === 1) {
          this.log("Il collegamento automatico ha bisogno di una prima sincronizzazione a mano: premi «Sincronizza ora» una volta.");
        }
      } else {
        this.log(`Sincronizzazione non riuscita: ${msg}`);
        new Notice(`Neo Pen: ${msg}`);
      }
      return false;
    }
  }

  /** Finestra "Memoria della penna": elenco delle pagine nella penna, recupero e cancellazione. */
  async openMemory(): Promise<void> {
    if (this.mobileGuard()) return;
    if (this.penBusy) {
      new Notice("Neo Pen: la penna è già impegnata, riprova tra poco.");
      return;
    }
    let release!: () => void;
    const closed = new Promise<void>((r) => (release = r));
    try {
      await this.withPen(
        async () => {
          this.setSync({ running: true, message: "Leggo l'elenco delle pagine nella penna…" });
          const keys = await this.pen.listMemory();
          this.setSync({ running: false, message: "Memoria della penna aperta: la penna resta collegata finché non chiudi la finestra." });
          const ids = keys.map(pageId);
          this.router.forgetMissing(ids);
          await this.saveSettings();
          const items: MemoryItem[] = keys.map((key) => {
            const svg = this.app.vault.getAbstractFileByPath(this.store.svgPath(pageId(key)));
            return {
              key,
              thumb: svg instanceof TFile ? this.app.vault.getResourcePath(svg) : null,
              noteName: this.router.get(key)?.file.basename ?? null,
              unseen: !this.store.entry(key),
            };
          });
          new PenMemoryModal(this.app, items, this.pen.getStatus().usedMemory, {
            recover: (chosen) => this.recoverPages(chosen),
            remove: async (chosen) => {
              const n = await this.pen.deletePages(chosen);
              for (const k of chosen) delete this.settings.pageIndex[pageId(k)];
              await this.saveSettings();
              this.log(`Cancellate dalla penna ${n} pagine: ${chosen.map((k) => `q.${k.note} p.${k.page}`).join(", ")}.`);
              return n;
            },
            closed: () => release(),
          }).open();
          await closed; // la penna resta collegata finché la finestra è aperta
        },
        { keepConnected: false }
      );
    } catch (e) {
      release?.();
      new Notice(`Neo Pen: ${(e as Error)?.message ?? e}`);
    } finally {
      this.setSync({ running: false, message: "" });
    }
  }

  /** Recupera pagine dalla penna (penna già collegata): le rilegge e le ritrascrive da capo. */
  private async recoverPages(keys: PageKey[]): Promise<void> {
    const sorted = [...keys].sort((a, b) => a.note - b.note || a.page - b.page);
    const canTranscribe = !!this.settings.apiKey;
    for (const key of sorted) {
      const d = await this.pen.downloadPage(key);
      if (!d) continue;
      await this.fromPen(key, d.count, d.strokes);
      if (canTranscribe) this.transcriber.enqueue(key, "all");
      else await this.router.ensure(key, { created: d.strokes[0]?.t || Date.now() });
    }
    this.log(`Recupero ${sorted.length} pagine: ${sorted.map((p) => `q.${p.note} p.${p.page}`).join(", ")}${canTranscribe ? " (con trascrizione)" : ""}.`);
  }

  /** Pagina corrente: quella della nota aperta (se è una nota Neo Pen) o l'ultima su cui hai scritto. */
  private currentKey(): PageKey | null {
    const toKey = (id: string): PageKey | null => {
      const [section, owner, note, page] = String(id).split("~")[0].split("_").map(Number);
      return [section, owner, note, page].every((n) => Number.isFinite(n)) ? { section, owner, note, page } : null;
    };
    const file = this.app.workspace.getActiveFile();
    if (file) {
      // pagine collegate a questa nota (possono essere più d'una: continuazioni, nota del giorno)
      const ids = Object.entries(this.settings.pageNotes)
        .filter(([, ref]) => ref.path === file.path)
        .map(([id]) => id);
      if (ids.length) {
        const last = this.lastKey ? pageId(this.lastKey) : "";
        return toKey(ids.includes(last) ? last : ids[ids.length - 1]);
      }
      const fmId = this.app.metadataCache.getFileCache(file)?.frontmatter?.neopen;
      if (fmId) return toKey(String(fmId));
    }
    return this.lastKey;
  }

  /** Pagine del quaderno che hanno testo nella nota aperta (in ordine di pagina). */
  private pagesOfActiveNote(): PageKey[] {
    const file = this.app.workspace.getActiveFile();
    if (!file) return [];
    const ids = new Set(
      Object.entries(this.settings.pageNotes)
        .filter(([, ref]) => ref.path === file.path)
        .map(([id]) => id.split("~")[0])
    );
    return [...ids]
      .map((id) => {
        const [section, owner, note, page] = id.split("_").map(Number);
        return { section, owner, note, page };
      })
      .filter((k) => Number.isFinite(k.page))
      .sort((a, b) => a.note - b.note || a.page - b.page);
  }

  async transcribeCurrent(mode: "new" | "all"): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Neo Pen: inserisci prima la chiave API di Claude nelle impostazioni.");
      return;
    }
    // nota con più pagine: scegli tu quale (prima sceglieva da solo, a volte quella sbagliata)
    const pages = this.pagesOfActiveNote();
    if (pages.length > 1) {
      new PagePicker(this.app, pages, (keys) => {
        void (async () => {
          for (const k of keys) await this.transcribePage(k, mode);
        })();
      }).open();
      return;
    }
    const key = pages[0] ?? this.currentKey();
    if (!key) {
      new Notice("Neo Pen: apri una nota di una pagina o sincronizza la penna.");
      return;
    }
    await this.transcribePage(key, mode);
  }

  private async transcribePage(key: PageKey, mode: "new" | "all"): Promise<void> {
    if (!this.store.has(key)) {
      // i tratti stanno nella penna: rileggiamo questa pagina
      try {
        await this.withPen(async () => {
          const d = await this.pen.downloadPage(key);
          if (d) await this.fromPen(key, d.count, d.strokes);
        });
      } catch (e) {
        new Notice(`Neo Pen: per trascrivere serve la penna accesa. ${(e as Error)?.message ?? e}`);
        return;
      }
      if (!this.store.has(key)) {
        new Notice(`Neo Pen: la pagina ${key.page} non è (più) nella memoria della penna.`);
        this.log(`Pagina ${key.page}: la penna non ha tratti salvati per questa pagina (forse scritta mentre era collegata), non posso ritrascriverla.`);
        return;
      }
    }
    this.log(`${mode === "all" ? "Ritrascrivo da capo" : "Trascrivo"} la pagina ${key.page}…`);
    this.transcriber.enqueue(key, mode);
  }

  /** Note fatte prima della v0.14: i #tag scritti nel testo vanno anche nelle proprietà. */
  async tagOldNotes(): Promise<void> {
    const structural = new Set(this.router.ruleTags());
    const paths = new Set(Object.values(this.settings.pageNotes).map((r) => r.path));
    let n = 0;
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile) || this.router.inBin(f.path) || this.router.isDaily(f)) continue;
      const content = await this.app.vault.read(f);
      const text = [...content.matchAll(/<!-- neopen:testo:[^>]+ -->([\s\S]*?)<!-- \/neopen:testo:[^>]+ -->/g)].map((m) => m[1]).join("\n");
      const tags = inlineTags(text).filter((t) => !structural.has(t));
      if (!tags.length) continue;
      await this.app.fileManager.processFrontMatter(f, (fm) => {
        const cur: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? String(fm.tags).split(/[,\s]+/) : [];
        const low = cur.map((c) => c.toLowerCase());
        const add = tags.filter((t) => !low.includes(t));
        if (add.length) {
          fm.tags = [...cur.filter(Boolean), ...add];
          n++;
        }
      });
    }
    if (n) this.log(`Tag del testo aggiunti alle proprietà di ${n} note.`);
  }

  /**
   * Disegni della v0.14.0 (immagine con le scritte dentro e sfondo bianco): diventano un disegno trasparente
   * con sopra le scritte come testo della nota.
   */
  async convertOldDrawings(): Promise<void> {
    const root = (this.settings.rootFolder || "NeoPen").replace(/\/+$/, "");
    const re = /^!\[\[([^\]|]*\/_disegni\/[^\]|]+\.svg)(?:\|[^\]]*)?\]\][ \t]*$/gm;
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(`${root}/_cestino/`)) continue;
      const content = await this.app.vault.cachedRead(f);
      if (!content.includes("/_disegni/")) continue;
      const blocks = new Map<string, string>();
      for (const m of content.matchAll(re)) {
        const svgFile = this.app.vault.getAbstractFileByPath(m[1]);
        if (!(svgFile instanceof TFile)) continue;
        const split = splitLegacyDrawing(await this.app.vault.read(svgFile));
        if (!split) continue;
        await this.app.vault.modify(svgFile, split.svg);
        blocks.set(m[0], formatDrawingBlock(m[1], split.labels));
      }
      if (!blocks.size) continue;
      await this.app.vault.process(f, (c) => c.replace(re, (all) => blocks.get(all) ?? all));
      n++;
    }
    if (n) this.log(`Disegni con le scritte modificabili in ${n} note.`);
    await this.labelsToLines();
  }

  /** v0.15: le scritte sopra i disegni diventano righe accanto al disegno (con la loro grandezza). */
  async labelsToLines(): Promise<void> {
    const root = (this.settings.rootFolder || "NeoPen").replace(/\/+$/, "");
    const re = new RegExp("```" + DRAWING_BLOCK + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*(?:\\r?\\n)?", "g");
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(`${root}/_cestino/`)) continue;
      const content = await this.app.vault.cachedRead(f);
      if (!content.includes("```" + DRAWING_BLOCK)) continue;
      const repl = new Map<string, string>();
      for (const m of content.matchAll(re)) {
        const spec = parseDrawingBlock(m[1]);
        if (!spec.labels.length || spec.beside) continue;
        const md = labelsToLines(spec.file, spec.labels);
        if (md) repl.set(m[0], md + "\n");
      }
      if (!repl.size) continue;
      await this.app.vault.process(f, (c) => c.replace(re, (all) => repl.get(all) ?? all));
      n++;
    }
    if (n) this.log(`Scritte dei disegni come righe accanto in ${n} note.`);
  }

  /** Una sola miniatura del disegno in ogni nota del plugin. */
  async tidyAllDrawings(): Promise<void> {
    const paths = new Set(Object.values(this.settings.pageNotes).map((r) => r.path));
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) await this.router.tidyDrawings(f).catch(() => 0);
    }
  }

  /** Allinea il calendario con tutte le note che contengono task scritti a mano. */
  async syncCalendarAll(): Promise<void> {
    const paths = new Set(Object.values(this.settings.pageNotes).map((r) => r.path));
    let n = 0;
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      try {
        n += await this.calendar.syncFile(f);
      } catch (e) {
        new Notice(`Neo Pen: calendario non raggiungibile. ${(e as Error)?.message ?? e}`, 10000);
        return;
      }
    }
    if (n) new Notice(`Neo Pen: calendario aggiornato (${n} eventi).`);
  }

  /** Applica subito l'impostazione "mostra marcatori" a tutti gli editor aperti. */
  refreshMarkers(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = (leaf.view as any)?.editor?.cm as EditorView | undefined;
      cm?.dispatch({ effects: refreshMarkers.of(null) });
    });
  }

  async runDiagnostics(): Promise<void> {
    const res = await collectDiagnostics(this.chooser.available);
    new DiagnosticsModal(
      this.app,
      res,
      async () => {
        if (!(await this.syncNow())) throw new Error("sincronizzazione non riuscita (vedi registro)");
      },
      () => this.logLines
    ).open();
  }

  async openLiveView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LIVE_VIEW)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: LIVE_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private updateStatusBar(): void {
    const s = this.pen.getStatus();
    const icon = s.state === "connesso" || s.state === "scaricamento" ? "🟢" : s.state === "disconnesso" ? "⚪" : "🟡";
    const batt = s.battery != null ? ` ${s.battery}%` : "";
    this.statusBar.setText(`${icon} Neo Pen${batt}`);
  }

  private askPassword(retry: number, reset: number): void {
    new PasswordModal(this, retry, reset, (pw) => this.pen.inputPassword(pw)).open();
  }

  // ---------------------------------------------------------------- impostazioni

  async loadSettings(): Promise<void> {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as NeoPenSettings;
    const data = ((await this.loadData()) ?? {}) as Partial<NeoPenSettings>;
    this.settings = Object.assign(defaults, data);
    if (!this.settings.calendarSecret) {
      const b = new Uint8Array(18);
      crypto.getRandomValues(b);
      this.settings.calendarSecret = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      if (!Platform.isMobile) await this.saveData(this.settings);
    }
    const version = data.settingsVersion ?? 1;
    // v0.5: la pausa breve di prima (10 s) faceva tante chiamate: passa a 60 s
    if (version < 2 && this.settings.idleSeconds <= 10) this.settings.idleSeconds = 60;
    // v0.6: niente più archivio _dati né cancellazioni automatiche dalla penna
    if (version < 3) {
      this.needsIndexImport = true;
      const legacy = this.settings as unknown as Record<string, unknown>;
      delete legacy.deleteAfterDownload;
      delete legacy.retentionHours;
      delete legacy.autoDownloadOnConnect;
    }
    // v0.12.2: note con il disegno incorporato due volte → una sola miniatura
    if (version < 6) this.needsDrawingTidy = true;
    // v0.11: gli eventi della 0.10 usavano il fuso di Google Calendar invece di quello del dispositivo: si risistemano
    if (version < 4 && this.settings.calendarEnabled) this.needsCalendarRepair = true;
    // v0.12.18: parole frequenti e letture sbagliate viste finora nelle tue pagine
    if (version < 7) {
      const merge = (cur: string, add: string[]) => {
        const have = cur.split(",").map((w) => w.trim()).filter(Boolean);
        const low = new Set(have.map((w) => w.toLowerCase()));
        return [...have, ...add.filter((w) => !low.has(w.toLowerCase()))].join(", ");
      };
      this.settings.vocabulary = merge(this.settings.vocabulary ?? "", [
        "video", "Vishi", "Kaan", "Nicole", "Pietro", "Ines", "cinema", "sceneggiatura", "Startup", "Launch",
        "LinkedIn", "color palette", "templates", "stretching", "disegnare", "domande", "risposte", "attrezzatura",
        "appuntamento", "chiamata", "camera", "call", "nuoto", "basket", "dentista", "parrucchiere",
      ]);
      this.settings.blacklist = merge(this.settings.blacklist ?? "", ["violeo", "violes", "olisegnare"]);
    }
    // v0.22: calendario e attività dei task scritti a penna li fa l'app sul telefono (calendario dell'iPhone e note
    // del giorno): il plugin smette di mandarli a Google Calendar / Todoist, se no arriverebbero due volte.
    if (version < 13) {
      if (this.settings.calendarEnabled) {
        this.settings.calendarEnabled = false;
        this.calendarHandedOver = true;
      }
      this.settings.settingsVersion = Math.max(13, this.settings.settingsVersion);
      if (!Platform.isMobile && version >= 12) await this.saveData(this.settings);
    }
    // v0.15: le scritte sopra i disegni diventano righe accanto (come il testo di fianco)
    if (version < 12) {
      this.needsDrawingBlocks = true;
      this.settings.settingsVersion = Math.max(12, this.settings.settingsVersion);
      if (!Platform.isMobile && version >= 11) await this.saveData(this.settings);
    }
    // v0.14.1: disegni trasparenti con le scritte come testo della nota
    if (version < 11) {
      this.needsDrawingBlocks = true;
      this.settings.settingsVersion = Math.max(11, this.settings.settingsVersion);
      if (!Platform.isMobile && version >= 10) await this.saveData(this.settings);
    }
    // v0.14: disegno della pagina in un riquadro chiuso, #tag del testo nelle proprietà (anche nelle note vecchie)
    if (version < 10) {
      this.needsTidyV14 = true;
      this.settings.settingsVersion = Math.max(10, this.settings.settingsVersion);
      if (!Platform.isMobile && version >= 9) await this.saveData(this.settings);
    }
    // v0.13.1: le pagine dall'iPhone si controllano ogni minuto (erano 2)
    if (version < 9) {
      if (this.settings.relayMinutes === 2) this.settings.relayMinutes = 1;
      this.settings.settingsVersion = Math.max(9, this.settings.settingsVersion);
      if (!Platform.isMobile && version >= 8) await this.saveData(this.settings);
    }
    // v0.13: le note scritte vanno in "Me", in una cartella per quaderno, senza la data nel nome
    if (version < 8) {
      const old = this.settings.notesFolder || this.settings.rootFolder || "NeoPen";
      if (old === (this.settings.rootFolder || "NeoPen")) this.settings.notesFolder = "Me";
      this.notebookMoveFrom = old;
      this.settings.settingsVersion = Math.max(8, this.settings.settingsVersion);
      if (!Platform.isMobile) await this.saveData(this.settings);
    }
    if (version < 7) {
      this.settings.settingsVersion = Math.max(7, this.settings.settingsVersion);
      if (!Platform.isMobile) await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    // Le impostazioni le scrive il PC. L'iPhone solo quando trascrive lui (PC spento): così due dispositivi non si
    // sovrascrivono a vicenda pagine, note e stato delle trascrizioni.
    if (Platform.isMobile && !this.mobileWorking) return;
    await this.saveData(this.settings);
  }
}

class PasswordModal extends Modal {
  constructor(
    private plugin: NeoPenPlugin,
    private retry: number,
    private reset: number,
    private submit: (pw: string) => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Password della penna");
    this.contentEl.createEl("p", {
      text:
        `La penna chiede la password (tentativo ${this.retry + 1} di ${this.reset || 10}). ` +
        "Attenzione: troppi tentativi sbagliati cancellano la memoria della penna.",
    });
    let value = "";
    new Setting(this.contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this.submit(value);
          this.close();
        }
      });
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Invia")
        .setCta()
        .onClick(() => {
          this.submit(value);
          this.close();
        })
    );
  }
}
