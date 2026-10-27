import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NeoPenPlugin from "./main";
import { MODELS, QUALITIES, Quality } from "./transcribe/claude";
import { SchemeModal, pageLabel } from "./views/handwriting";
import { SAMPLE_LANGS, resolveLang } from "./transcribe/samples";
import type { PageIndexEntry } from "./store/PageStore";
import type { CalendarEntry } from "./calendar/CalendarSync";
import { appsScript, callCalendar, callRelay } from "./calendar/GoogleCalendar";
import { Todoist } from "./calendar/Todoist";
import { validTimezone } from "./calendar/CalendarSync";

/** Cosa fare quando in cima alla pagina c'è uno di questi tag. */
export interface TagRule {
  /** Tag che attivano la regola, senza # (es. ["task", "tasks"]). */
  tags: string[];
  /** "note": una nota dal template; "daily": nella nota del giorno, sotto un'intestazione. */
  action: "note" | "daily";
  /** Percorso del template nel vault (vuoto = template di base). Solo per "note". */
  template: string;
  /** Cartella delle note create. Solo per "note". */
  folder: string;
  /** Titolo della nota: {{date}}, {{titolo}}, {{tag}}, {{quaderno}}, {{pagina}}. Solo per "note". */
  title: string;
  /** Intestazione sotto cui scrivere. Solo per "daily". */
  heading: string;
  /** Incorpora il disegno della pagina. */
  drawing: boolean;
  /** I task con data o orario vanno nel calendario (di default sì per la nota del giorno). */
  calendar?: boolean;
}

export interface PageNoteRef {
  path: string;
  drawing: boolean;
  /** Nota di base creata in automatico (senza tag): può essere promossa se il tag arriva dopo. */
  auto?: boolean;
  /** Titolo scritto a mano già applicato alla nota. */
  title?: string;
  /** I task di questa pagina vanno nel calendario. */
  calendar?: boolean;
}

export interface NeoPenSettings {
  rootFolder: string;
  notesFolder: string;
  /** Sottocartella per ogni quaderno dentro la cartella note: {{inizio}} (o {{inizio:DD-MM-YYYY}}), {{quaderno}}. Vuoto = niente sottocartella. */
  notebookFolder: string;
  /** Quaderni conosciuti: id "sezione_proprietario_quaderno" → data di inizio (YYYY-MM-DD) e cartella. */
  notebooks: Record<string, { start: string; path: string }>;
  /** In Esplora file si vede solo la cartella note (le altre si mostrano col comando). */
  explorerOnlyNotes: boolean;
  /** Cartelle in cima al vault che si nascondono (le altre, create da te, restano visibili). */
  hiddenFolders: string[];
  /** Le cartelle fuori dalla cartella note sono "file esclusi" di Obsidian: non compaiono nel grafo e nella ricerca. */
  excludeOthers: boolean;
  /** Filtri aggiunti dal plugin ai "file esclusi" (per toglierli se spegni l'opzione). */
  ignoreAdded: string[];
  /** Pagine #alfabeto: campioni della tua calligrafia mandati con ogni trascrizione. */
  handwritingRefs: string[];
  /** Mandare i campioni a Claude (si possono tenere senza usarli). */
  handwritingEnabled: boolean;
  /** Quante pagine di campioni mandare con ogni trascrizione (1–6). */
  handwritingMax: number;
  /** Lingua delle frasi di riferimento dello schema ("auto" = quella di Obsidian). */
  handwritingLang: string;
  createNotes: boolean;
  /** Si collega da solo quando accendi la penna (tappo aperto), sincronizza e si scollega. */
  autoSync: boolean;
  /** Mentre la penna resta accesa, risincronizza ogni N minuti. */
  syncEveryMinutes: number;
  /** Salva in <cartella>/_debug ogni immagine mandata a Claude, la richiesta, la risposta e il registro. */
  debugDump?: boolean;
  sdkDebug: boolean;
  apiKey: string;
  /** Indirizzo del servizio che trascrive (vuoto = Claude). Un agente locale compatibile con l'API Messages si mette qui. */
  apiBaseUrl: string;
  model: string;
  autoTranscribe: boolean;
  idleSeconds: number;
  vocabulary: string;
  /** Letture sbagliate tipiche della tua grafia (es. "violeo" per "video"): da non usare mai. */
  blacklist: string;
  /** Quanto "ragiona" il modello prima di rispondere (incide molto sul costo). */
  quality: Quality;
  /** Spesa stimata del mese corrente (in dollari) e mese a cui si riferisce (YYYY-MM). */
  spendMonth: string;
  spendTotal: number;
  /** Regole tag → tipo di nota (modificabili nelle impostazioni). */
  rules: TagRule[];
  /** Titolo delle note senza tag. */
  defaultTitle: string;
  /** Un tag senza regola usa il template con lo stesso nome (cartella di Templater o dei Modelli). */
  autoTemplates: boolean;
  /** Mostra nell'editor i marcatori dei blocchi e l'etichetta "Pagina N". */
  showMarkers: boolean;
  // --- calendario (Google, tramite Apps Script) ---
  calendarEnabled: boolean;
  calendarUrl: string;
  calendarSecret: string;
  /** Legge dallo script le pagine che l'iPhone (Bluefy) ha mandato. */
  relayEnabled: boolean;
  /** Forza massima della penna (serve a disegnare lo spessore del tratto uguale su ogni dispositivo). */
  penMaxForce: number;
  relayMinutes: number;
  calendarId: string;
  eventMinutes: number;
  calendarAllDay: boolean;
  calendarEverywhere: boolean;
  /** Task senza orario → Google Tasks. */
  googleTasks: boolean;
  /** Lista di Google Tasks (nome; vuoto = predefinita). */
  tasksList: string;
  /** Dove vanno i task senza orario. */
  tasksTarget: "google" | "todoist" | "none";
  todoistToken: string;
  /** Progetto di Todoist (nome; vuoto = Inbox). */
  todoistProject: string;
  /** Fuso degli eventi: "device" (automatico), "calendar" (quello di Google Calendar) o un nome come "Europe/Rome". */
  eventTimezone: string;
  /** Versione delle impostazioni salvate (per aggiornare i valori vecchi). */
  settingsVersion: number;
  // --- stato interno (non mostrato) ---
  /** id pagina → nota in cui finisce. */
  pageNotes: Record<string, PageNoteRef>;
  /** Titoli letti male e corretti da te rinominando la nota: lettura sbagliata (minuscola, senza segni) → titolo giusto. */
  titleFixes: Record<string, string>;
  /** id pagina → parti della pagina (una nota per ogni titolo con doppia sottolineatura), in ordine. */
  segments: Record<string, string[]>;
  /**
   * Dove sta sulla carta ogni riga trascritta (per pagina, unità Ncode): una modifica scritta dopo su quella riga
   * cambia proprio quella riga della nota.
   */
  lineRows?: Record<string, { bid: string; text: string; y: number; x0: number; x1: number }[]>;
  /**
   * id pagina → parti della pagina nella nota di un altro giorno: righe scritte in un giorno successivo su una pagina
   * cominciata prima vanno nella nota del giorno in cui le hai scritte (`of` = la parte della pagina da cui vengono).
   */
  daySegments?: Record<string, { bid: string; of: string }[]>;
  /** id pagina → id della pagina di cui è la continuazione (freccia → numero). */
  continuations: Record<string, string>;
  /** id pagina → quanti tratti aveva nella penna e fin dove è trascritta (i tratti stanno nella penna). */
  pageIndex: Record<string, PageIndexEntry>;
  /** task → evento del calendario. */
  calendarEvents: Record<string, CalendarEntry>;
}

export const DEFAULT_RULES: TagRule[] = [
  { tags: ["task", "tasks"], action: "daily", template: "", folder: "", title: "", heading: "## Task", drawing: false, calendar: true },
];

export const DEFAULT_SETTINGS: NeoPenSettings = {
  rootFolder: "NeoPen",
  notesFolder: "NeoPen",
  createNotes: true,
  autoSync: true,
  syncEveryMinutes: 5,
  sdkDebug: false,
  apiKey: "",
  apiBaseUrl: "",
  model: "claude-sonnet-5-5",
  autoTranscribe: true,
  idleSeconds: 60,
  vocabulary: "",
  blacklist: "",
  quality: "economica",
  spendMonth: "",
  spendTotal: 0,
  rules: DEFAULT_RULES,
  defaultTitle: "Quaderno {{quaderno}} - pagina {{pagina}}",
  autoTemplates: true,
  showMarkers: false,
  calendarEnabled: false,
  calendarUrl: "",
  calendarSecret: "",
  relayEnabled: true,
  penMaxForce: 0,
  relayMinutes: 1,
  calendarId: "",
  eventMinutes: 30,
  calendarAllDay: true,
  calendarEverywhere: false,
  googleTasks: true,
  tasksList: "",
  tasksTarget: "google",
  todoistToken: "",
  todoistProject: "",
  eventTimezone: "device",
  settingsVersion: 13,
  pageNotes: {},
  titleFixes: {},
  notebookFolder: "Taccuino {{inizio}}",
  notebooks: {},
  explorerOnlyNotes: true,
  hiddenFolders: ["Audio", "Daily", "NeoPen", "Templates"],
  excludeOthers: true,
  ignoreAdded: [],
  handwritingRefs: [],
  handwritingEnabled: true,
  handwritingMax: 4,
  handwritingLang: "auto",
  continuations: {},
  segments: {},
  pageIndex: {},
  calendarEvents: {},
};

export class NeoPenSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NeoPenPlugin) {
    super(app, plugin);
  }

  /** La tua calligrafia: lo schema da scrivere e le pagine campione (per chiunque usi il plugin). */
  private renderHandwriting(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const root = (s.rootFolder || "NeoPen").replace(/\/+$/, "");
    const refs = s.handwritingRefs ?? [];
    new Setting(containerEl).setName("La tua calligrafia").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Per leggere meglio la tua scrittura (soprattutto il corsivo), Claude guarda alcune pagine in cui hai scritto lettere, numeri e parole secondo uno schema. " +
        "Scrivi quelle pagine con la penna cominciando con #alfabeto in alto: non diventano note, ma campioni della tua calligrafia. Oppure scegli qui sotto una pagina già scritta.",
    });

    new Setting(containerEl)
      .setName("Schema da scrivere")
      .setDesc("Cosa scrivere nelle pagine campione: maiuscole e minuscole, stampatello e corsivo, lettere che si confondono, numeri, simboli, parole frequenti.")
      .addButton((b) => b.setCta().setButtonText("Apri lo schema").onClick(() => new SchemeModal(this.app, "Schema calligrafia.md", resolveLang(s.handwritingLang)).open()));

    const lang = resolveLang(s.handwritingLang);
    new Setting(containerEl)
      .setName("Lingua delle frasi di riferimento")
      .setDesc(`Le due frasi da copiare (punto 9 dello schema) sono nella lingua in cui scrivi: contengono tutte le lettere, gli accenti e le coppie di lettere tipiche. Ora: ${SAMPLE_LANGS[lang].name}. Se la cambi, riscrivi le due frasi nella nuova lingua.`)
      .addDropdown((d) => {
        d.addOption("auto", "Come Obsidian");
        for (const [k, v] of Object.entries(SAMPLE_LANGS)) d.addOption(k, v.name);
        d.setValue(s.handwritingLang || "auto").onChange(async (v) => {
          s.handwritingLang = v;
          await save();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Usa i campioni")
      .setDesc("Ogni pagina di campioni aggiunge un po' di costo a ogni trascrizione (meno di quanto sembra: le immagini restano in cache tra una pagina e l'altra).")
      .addToggle((t) =>
        t.setValue(s.handwritingEnabled !== false).onChange(async (v) => {
          s.handwritingEnabled = v;
          await save();
        })
      )
      .addDropdown((d) => {
        for (let i = 1; i <= 6; i++) d.addOption(String(i), i === 1 ? "1 pagina" : `${i} pagine`);
        d.setValue(String(s.handwritingMax || 4)).onChange(async (v) => {
          s.handwritingMax = Number(v);
          await save();
          this.display();
        });
      });

    const max = s.handwritingMax || 4;
    if (!refs.length) {
      containerEl.createEl("p", { cls: "setting-item-description neopen-samples-empty", text: "Nessun campione per ora." });
    } else {
      const grid = containerEl.createDiv({ cls: "neopen-samples" });
      refs.forEach((id, i) => {
        const card = grid.createDiv({ cls: "neopen-sample" });
        const used = i >= refs.length - max;
        if (!used) card.addClass("is-unused");
        const path = this.plugin.transcriber.samplePath(id);
        card.createEl("img", { attr: { src: this.app.vault.adapter.getResourcePath(path), alt: pageLabel(id) } });
        const foot = card.createDiv({ cls: "neopen-sample-foot" });
        foot.createSpan({ text: pageLabel(id) + (used ? "" : " · non usata") });
        const rm = foot.createEl("button", { text: "Togli" });
        rm.addEventListener("click", async () => {
          await this.plugin.transcriber.removeSample(id);
          this.display();
        });
      });
      if (refs.length > max) containerEl.createEl("p", { cls: "setting-item-description", text: `Vengono usate le ultime ${max}: quelle segnate «non usata» restano qui ma non vanno a Claude.` });
    }

    // una pagina già scritta (con o senza #alfabeto) come campione
    const add = new Setting(containerEl).setName("Aggiungi una pagina già scritta").setDesc("Le pagine lette dalla penna. La pagina scelta non verrà più trascritta come nota.");
    let pick = "";
    add.addDropdown((d) => {
      d.addOption("", "Scegli una pagina…");
      void (async () => {
        const dir = `${root}/_pagine`;
        if (!(await this.app.vault.adapter.exists(dir))) return;
        const ids = (await this.app.vault.adapter.list(dir)).files
          .map((f) => /([^/]+)\.svg$/.exec(f)?.[1] ?? "")
          .filter((id) => /^\d+_\d+_\d+_\d+$/.test(id) && !refs.includes(id))
          .sort((x, y) => {
            const a = x.split("_").map(Number),
              b = y.split("_").map(Number);
            return a[2] - b[2] || a[3] - b[3];
          });
        for (const id of ids) d.addOption(id, pageLabel(id));
      })();
      d.onChange((v) => (pick = v));
    });
    add.addButton((b) =>
      b.setButtonText("Aggiungi").onClick(async () => {
        if (!pick) return;
        const ok = await this.plugin.transcriber.addSampleFromPage(pick);
        new Notice(ok ? `${pageLabel(pick)}: aggiunta ai campioni.` : "Non trovo l'immagine di quella pagina.");
        this.display();
      })
    );

    if (refs.length)
      new Setting(containerEl).setName("Ricomincia da capo").setDesc("Toglie tutti i campioni (le pagine restano sulla penna).").addButton((b) =>
        b.setWarning().setButtonText("Togli tutti").onClick(async () => {
          for (const id of [...refs]) await this.plugin.transcriber.removeSample(id);
          this.display();
        })
      );
  }

  private renderCalendar(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    new Setting(containerEl).setName("Calendario e attività").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "I task scritti a mano con un orario («alle 15», «14:00 - 14:30») diventano eventi di Google Calendar (quindi anche in Fantastical); quelli senza orario diventano attività di Todoist o di Google Tasks. " +
        "Se li spunti con la penna o in Obsidian l'evento prende una ✓ e l'attività risulta completata; se cancelli il task, sparisce anche da lì. " +
        "Valgono i task delle pagine con un tag che ha l'opzione calendario attiva (di default #task e #tasks).",
    });

    const steps = containerEl.createEl("ol", { cls: "setting-item-description" });
    steps.createEl("li", { text: "Premi «Copia lo script» qui sotto." });
    steps.createEl("li", { text: "Apri script.google.com → Nuovo progetto, cancella tutto e incolla. Salva." });
    steps.createEl("li", { text: "Esegui il deploy → Nuovo deployment → tipo «App web»; Esegui come: Me; Chi ha accesso: Chiunque. Autorizza l'accesso al calendario." });
    steps.createEl("li", { text: "Copia l'URL dell'app web (finisce con /exec) nel campo qui sotto e premi «Prova»." });

    new Setting(containerEl)
      .setName("Script per Google Calendar")
      .setDesc("Contiene la tua chiave segreta: non condividerlo.")
      .addButton((b) =>
        b.setButtonText("Copia lo script").onClick(async () => {
          await navigator.clipboard.writeText(appsScript(s.calendarSecret));
          new Notice("Script copiato: incollalo in script.google.com");
        })
      );

    new Setting(containerEl)
      .setName("URL dell'app web")
      .addText((t) => {
        t.inputEl.style.width = "100%";
        t.setPlaceholder("https://script.google.com/macros/s/…/exec")
          .setValue(s.calendarUrl)
          .onChange(async (v) => {
            s.calendarUrl = v.trim();
            await save();
          });
      })
      .addButton((b) =>
        b.setButtonText("Prova").onClick(async () => {
          b.setDisabled(true);
          try {
            const [r] = await callCalendar(s.calendarUrl, s.calendarSecret, s.calendarId, [{ action: "ping" }]);
            if (!r?.ok) new Notice(`Neo Pen: ${r?.error ?? "nessuna risposta"}`);
            else if (s.tasksTarget === "google" && !r.tasks)
              new Notice(
                `Neo Pen: collegato al calendario «${r.calendar}». Per Google Tasks manca il servizio nello script: Servizi (+) → Google Tasks API → Aggiungi, poi ripubblica con «Nuova versione».`,
                15000
              );
            else new Notice(`Neo Pen: collegato al calendario «${r.calendar}»${r.tasks ? " e a Google Tasks" : ""}.`);
          } catch (e) {
            new Notice(`Neo Pen: ${(e as Error)?.message ?? e}`, 10000);
          }
          b.setDisabled(false);
        })
      );

    new Setting(containerEl).setName("Lettura dall'iPhone (Bluefy)").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "L'iPhone legge la penna con la pagina in Bluefy e lascia le pagine nello stesso script Google (cartella «NeoPen-iPhone» su Drive). Qui il PC le prende e le trascrive. Serve lo script aggiornato (copialo di nuovo e ripubblicalo con «Nuova versione»).",
    });
    new Setting(containerEl)
      .setName("Prendi le pagine mandate dall'iPhone")
      .addToggle((t) =>
        t.setValue(s.relayEnabled).onChange(async (v) => {
          s.relayEnabled = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Controlla ogni (minuti)")
      .addText((t) =>
        t.setValue(String(s.relayMinutes ?? 2)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            s.relayMinutes = Math.round(n);
            await save();
          }
        })
      );
    new Setting(containerEl)
      .setName("Dati da copiare nella pagina dell'iPhone")
      .setDesc("Crea la nota «NeoPen/Collegamento iPhone» con l'indirizzo e la chiave: aprila sull'iPhone, copia i due valori nella pagina e poi cancella la nota.")
      .addButton((b) =>
        b.setButtonText("Crea la nota").onClick(async () => {
          await (this.plugin as any).writeIphoneNote?.();
        })
      )
      .addButton((b) =>
        b.setButtonText("Prova lo script").onClick(async () => {
          try {
            await callRelay(s.calendarUrl, s.calendarSecret, { action: "ping" });
            new Notice("Neo Pen: lo script è pronto per l'iPhone.");
          } catch (e) {
            new Notice(`Neo Pen: ${(e as Error)?.message ?? e}`, 10000);
          }
        })
      );

    new Setting(containerEl)
      .setName("Manda i task al calendario e alle attività")
      .addToggle((t) =>
        t.setValue(s.calendarEnabled).onChange(async (v) => {
          s.calendarEnabled = v;
          await save();
          if (v) void this.plugin.syncCalendarAll();
        })
      );

    new Setting(containerEl)
      .setName("Calendario")
      .setDesc("Vuoto = il tuo calendario principale. Per un altro calendario incolla il suo «ID calendario» (Impostazioni di Google Calendar → calendario → Integra calendario).")
      .addText((t) =>
        t.setPlaceholder("principale").setValue(s.calendarId).onChange(async (v) => {
          s.calendarId = v.trim();
          await save();
        })
      );

    const tzMode = !s.eventTimezone || s.eventTimezone === "device" ? "device" : s.eventTimezone === "calendar" ? "calendar" : "manual";
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Setting(containerEl)
      .setName("Fuso orario degli eventi")
      .setDesc(`«Automatico» usa il fuso di questo dispositivo (ora: ${deviceTz}), come fa il telefono. Cambialo solo se gli eventi finiscono all'ora sbagliata.`)
      .addDropdown((d) =>
        d
          .addOption("device", "Automatico (questo dispositivo)")
          .addOption("calendar", "Quello di Google Calendar")
          .addOption("manual", "Scelgo io…")
          .setValue(tzMode)
          .onChange(async (v) => {
            s.eventTimezone = v === "manual" ? (validTimezone(s.eventTimezone) ? s.eventTimezone : deviceTz) : v;
            await save();
            this.display();
            if (s.calendarEnabled) void this.plugin.syncCalendarAll();
          })
      );
    if (tzMode === "manual") {
      new Setting(containerEl)
        .setName("Fuso orario")
        .setDesc("Nome del fuso, per esempio Europe/Rome o America/Los_Angeles.")
        .addText((t) =>
          t.setPlaceholder("Europe/Rome").setValue(s.eventTimezone).onChange(async (v) => {
            const tz = v.trim();
            if (!validTimezone(tz)) return;
            s.eventTimezone = tz;
            await save();
          })
        )
        .addButton((b) =>
          b.setButtonText("Applica").onClick(async () => {
            if (!validTimezone(s.eventTimezone)) {
              new Notice("Neo Pen: fuso orario non valido.");
              return;
            }
            await this.plugin.syncCalendarAll();
            new Notice(`Neo Pen: eventi nel fuso ${s.eventTimezone}.`);
          })
        );
    }

    new Setting(containerEl)
      .setName("Durata degli eventi (minuti)")
      .addSlider((sl) =>
        sl
          .setLimits(5, 180, 5)
          .setValue(s.eventMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.eventMinutes = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Task senza orario")
      .setDesc("Dove vanno le caselle senza orario (con scadenza se hai scritto una data; nella nota del giorno, il giorno della nota).")
      .addDropdown((d) =>
        d
          .addOption("todoist", "Todoist")
          .addOption("google", "Google Tasks")
          .addOption("none", "Restano solo nella nota")
          .setValue(s.tasksTarget ?? (s.googleTasks === false ? "none" : "google"))
          .onChange(async (v) => {
            s.tasksTarget = v as typeof s.tasksTarget;
            await save();
            this.display();
            if (s.calendarEnabled) void this.plugin.syncCalendarAll();
          })
      );

    if (s.tasksTarget === "todoist") {
      new Setting(containerEl)
        .setName("Token di Todoist")
        .setDesc("Todoist → Impostazioni → Integrazioni → Sviluppatore → copia il «Token API». Resta salvato solo nelle impostazioni del plugin.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("token").setValue(s.todoistToken).onChange(async (v) => {
            s.todoistToken = v.trim();
            await save();
          });
        })
        .addButton((b) =>
          b.setButtonText("Prova").onClick(async () => {
            b.setDisabled(true);
            try {
              const projects = await new Todoist(s.todoistToken).projects();
              new Notice(`Neo Pen: collegato a Todoist (${projects.length} progetti).`);
            } catch (e) {
              new Notice(`Neo Pen: ${(e as Error)?.message ?? e}`, 10000);
            }
            b.setDisabled(false);
          })
        );
      new Setting(containerEl)
        .setName("Progetto di Todoist")
        .setDesc("Nome del progetto (viene creato se non c'è). Vuoto = Inbox.")
        .addText((t) =>
          t.setPlaceholder("Inbox").setValue(s.todoistProject).onChange(async (v) => {
            s.todoistProject = v.trim();
            await save();
          })
        );
    } else if (s.tasksTarget !== "none") {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "Per Google Tasks serve il servizio «Google Tasks API» nello script: script.google.com → Servizi (+) → Google Tasks API → Aggiungi, poi ripubblica con «Nuova versione».",
      });
      new Setting(containerEl)
        .setName("Lista di Google Tasks")
        .setDesc("Nome della lista (viene creata se non c'è). Vuoto = la tua lista predefinita.")
        .addText((t) =>
          t.setPlaceholder("predefinita").setValue(s.tasksList).onChange(async (v) => {
            s.tasksList = v.trim();
            await save();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Task con la sola data → evento di un giorno intero")
        .setDesc("Spento: nel calendario vanno solo i task con un orario.")
        .addToggle((t) =>
          t.setValue(s.calendarAllDay).onChange(async (v) => {
            s.calendarAllDay = v;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Anche i task delle altre note")
      .setDesc("Acceso: qualsiasi task scritto a mano con data o orario va nel calendario, in qualsiasi nota.")
      .addToggle((t) =>
        t.setValue(s.calendarEverywhere).onChange(async (v) => {
          s.calendarEverywhere = v;
          await save();
        })
      );
  }

  private renderRules(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    new Setting(containerEl).setName("Tag e tipi di nota").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Il #tag scritto da solo sulla prima riga della pagina decide dove va la pagina. Gli altri #tag scritti ovunque vengono aggiunti ai tag della nota. " +
        "Il titolo della nota è la riga SOTTOLINEATA in cima alla pagina (sotto il tag): se non c'è, si usa la prima riga. " +
        "Una freccia verso un numero (→ 7) fa continuare la nota sulla pagina 7. " +
        "Nei titoli e nei template puoi usare {{titolo}} (o {{title}}), {{date}}, {{date:DD/MM/YYYY}}, {{time}}, {{tag}}, {{quaderno}}, {{pagina}}; nei template anche {{disegno}} e {{testo}}.",
    });

    new Setting(containerEl)
      .setName("Mostra i marcatori delle pagine")
      .setDesc(
        "Spento: il testo di più pagine scorre unico, senza interruzioni. Acceso: nell'editor vedi i marcatori <!-- neopen:testo… --> e un'etichetta \"Pagina N\" sopra ogni pagina (utile per capire dove finisce cosa)."
      )
      .addToggle((t) =>
        t.setValue(s.showMarkers).onChange(async (v) => {
          s.showMarkers = v;
          await save();
          this.plugin.refreshMarkers();
        })
      );

    const tplFolders = this.plugin.router.templateFolders();
    const tplNames = this.plugin.router.templateFiles().map((f) => f.basename);
    new Setting(containerEl)
      .setName("Template con lo stesso nome del tag")
      .setDesc(
        (tplFolders.length
          ? `Un #tag in cima senza regola usa il template con lo stesso nome nella cartella ${tplFolders.map((f) => `"${f}"`).join(" o ")} ` +
            `(es. #${(tplNames[0] ?? "riunione").toLowerCase().replace(/\s+/g, "")} → "${tplNames[0] ?? "Riunione"}"). `
          : "Un #tag in cima senza regola usa il template con lo stesso nome (imposta la cartella dei template in Templater). ") +
          "I comandi di Templater (<% … %>) vengono eseguiti. Nel template scrivi {{testo}} dove vuoi la trascrizione." +
          (tplNames.length ? ` Template trovati: ${tplNames.join(", ")}.` : "")
      )
      .addToggle((t) =>
        t.setValue(s.autoTemplates !== false).onChange(async (v) => {
          s.autoTemplates = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Titolo delle note senza tag")
      .addText((t) =>
        t.setValue(s.defaultTitle).onChange(async (v) => {
          s.defaultTitle = v.trim() || DEFAULT_SETTINGS.defaultTitle;
          await save();
        })
      );

    s.rules.forEach((rule, i) => {
      const box = containerEl.createDiv("neopen-rule");
      new Setting(box)
        .setName(`Regola ${i + 1}`)
        .setDesc("Tag (separati da virgola, senza #)")
        .addText((t) =>
          t.setPlaceholder("riunione, meeting").setValue(rule.tags.join(", ")).onChange(async (v) => {
            rule.tags = v
              .split(",")
              .map((x) => x.replace(/^#/, "").trim().toLowerCase())
              .filter(Boolean);
            await save();
          })
        )
        .addDropdown((d) =>
          d
            .addOption("note", "Nota da template")
            .addOption("daily", "Nella nota del giorno")
            .setValue(rule.action)
            .onChange(async (v) => {
              rule.action = v as TagRule["action"];
              await save();
              this.display();
            })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Elimina regola").onClick(async () => {
            s.rules.splice(i, 1);
            await save();
            this.display();
          })
        );
      if (rule.action === "note") {
        new Setting(box)
          .setName("Template")
          .setDesc("Nome del template (es. Riunione) o percorso nel vault; vuoto = template di base. Funziona anche con Templater.")
          .addText((t) =>
          t.setPlaceholder("Riunione").setValue(rule.template).onChange(async (v) => {
            rule.template = v.trim();
            await save();
          })
        );
        new Setting(box).setName("Cartella").addText((t) =>
          t.setPlaceholder("Riunioni").setValue(rule.folder).onChange(async (v) => {
            rule.folder = v.trim();
            await save();
          })
        );
        new Setting(box).setName("Titolo").addText((t) =>
          t.setPlaceholder("{{titolo}}").setValue(rule.title).onChange(async (v) => {
            rule.title = v.trim();
            await save();
          })
        );
      } else {
        new Setting(box).setName("Intestazione").setDesc("Sezione della nota del giorno in cui scrivere.").addText((t) =>
          t.setPlaceholder("## Task").setValue(rule.heading).onChange(async (v) => {
            rule.heading = v.trim() || "## Task";
            await save();
          })
        );
      }
      new Setting(box).setName("Incorpora il disegno").addToggle((t) =>
        t.setValue(rule.drawing).onChange(async (v) => {
          rule.drawing = v;
          await save();
        })
      );
      new Setting(box)
        .setName("Task con data o orario nel calendario")
        .addToggle((t) =>
          t.setValue(rule.calendar ?? rule.action === "daily").onChange(async (v) => {
            rule.calendar = v;
            await save();
          })
        );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Aggiungi regola").onClick(async () => {
        s.rules.push({ tags: [], action: "note", template: "", folder: "", title: "{{titolo}}", heading: "## Task", drawing: true });
        await save();
        this.display();
      })
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Cartella dati")
      .setDesc("Qui finiscono i tratti grezzi (_dati) e i disegni SVG (_pagine).")
      .addText((t) =>
        t.setPlaceholder("NeoPen").setValue(s.rootFolder).onChange(async (v) => {
          s.rootFolder = v.trim() || "NeoPen";
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Cartella note")
      .setDesc("Dove creare le note scritte con la penna (dentro, una cartella per ogni quaderno).")
      .addText((t) =>
        t.setPlaceholder("Me").setValue(s.notesFolder).onChange(async (v) => {
          s.notesFolder = v.trim() || s.rootFolder;
          await save();
          this.plugin.applyVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Cartella di ogni quaderno")
      .setDesc("Nome della sottocartella: {{inizio}} è il giorno in cui hai iniziato il quaderno (o {{inizio:DD.MM.YYYY}} per un altro formato), {{quaderno}} il suo numero. Vuoto = tutte le note direttamente nella cartella note. Vale per i quaderni nuovi.")
      .addText((t) =>
        t.setPlaceholder("Taccuino {{inizio}}").setValue(s.notebookFolder).onChange(async (v) => {
          s.notebookFolder = v.trim();
          await save();
        })
      );

    for (const [nb, info] of Object.entries(s.notebooks ?? {})) {
      new Setting(containerEl)
        .setName(`Quaderno ${nb.split("_").pop()}: iniziato il`)
        .setDesc(`Cartella "${info.path}". Cambiando la data, la cartella si rinomina.`)
        .addText((t) => {
          t.inputEl.type = "date";
          t.setValue(info.start).onChange(async (v) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
            await this.plugin.router.setNotebookStart(nb, v);
          });
        });
    }

    new Setting(containerEl)
      .setName("In Esplora file solo la cartella note")
      .setDesc("Nasconde le cartelle elencate qui sotto (Daily, Templates, Audio, NeoPen…). Restano raggiungibili: comando «Neo Pen: mostra/nascondi le altre cartelle», ricerca rapida e link.")
      .addToggle((t) =>
        t.setValue(s.explorerOnlyNotes).onChange(async (v) => {
          s.explorerOnlyNotes = v;
          await save();
          this.plugin.applyVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Cartelle da nascondere")
      .setDesc("Nomi delle cartelle in cima al vault, separati da virgola. Solo queste si nascondono; le cartelle che crei tu restano sempre visibili.")
      .addText((t) =>
        t.setValue((s.hiddenFolders ?? []).join(", ")).onChange(async (v) => {
          s.hiddenFolders = v.split(",").map((x) => x.trim()).filter(Boolean);
          await save();
          this.plugin.applyVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Grafo e ricerca: solo la cartella note")
      .setDesc("Mette le altre cartelle tra i «File esclusi» di Obsidian (Impostazioni → File e link): spariscono da grafo e ricerca, ma si aprono normalmente.")
      .addToggle((t) =>
        t.setValue(s.excludeOthers).onChange(async (v) => {
          s.excludeOthers = v;
          await save();
          this.plugin.applyVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Crea una nota per pagina")
      .setDesc("La nota viene creata una volta sola: il disegno incorporato si aggiorna da solo, il testo che scrivi resta tuo.")
      .addToggle((t) =>
        t.setValue(s.createNotes).onChange(async (v) => {
          s.createNotes = v;
          await save();
        })
      );

    new Setting(containerEl).setName("Trascrizione").setHeading();

    new Setting(containerEl)
      .setName("Chiave API di Claude")
      .setDesc(
        "Si crea su platform.claude.com → API Keys. Resta salvata nel file data.json del plugin dentro il vault: se sincronizzi il vault, viaggia con lui."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...")
          .setValue(s.apiKey)
          .onChange(async (v) => {
            s.apiKey = v.trim();
            await save();
          });
      });

    new Setting(containerEl)
      .setName("Indirizzo del servizio (avanzato)")
      .setDesc("Lascia vuoto per usare Claude. Se vuoi usare un tuo agente, scrivi qui il suo indirizzo (per esempio https://mio-server:8080): deve accettare le stesse richieste dell'API Messages di Claude su /v1/messages.")
      .addText((t) =>
        t
          .setPlaceholder("https://api.anthropic.com")
          .setValue(s.apiBaseUrl ?? "")
          .onChange(async (v) => {
            s.apiBaseUrl = v.trim();
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Modello")
      .setDesc("Opus legge meglio il corsivo ma costa il doppio di Sonnet; Haiku costa pochissimo ma sbaglia di più. Il costo di ogni trascrizione compare nel registro.")
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(MODELS)) d.addOption(id, label);
        d.setValue(s.model).onChange(async (v) => {
          s.model = v;
          await save();
        });
      });

    new Setting(containerEl)
      .setName("Ragionamento del modello")
      .setDesc(
        "Il ragionamento si paga come testo di risposta (la parte più cara). Per trascrivere di solito non serve: prova 'Economica' e passa a 'Bilanciata' solo se sbaglia troppo."
      )
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(QUALITIES)) d.addOption(id, label);
        d.setValue(s.quality).onChange(async (v) => {
          s.quality = v as Quality;
          await save();
        });
      });

    const month = new Date().toISOString().slice(0, 7);
    const spent = s.spendMonth === month ? s.spendTotal : 0;
    new Setting(containerEl)
      .setName("Spesa stimata di questo mese")
      .setDesc(
        `≈ ${spent.toFixed(2).replace(".", ",")} $ (stima del plugin, calcolata dai token di ogni trascrizione; il dato ufficiale è nella Console di Claude).`
      )
      .addButton((b) =>
        b.setButtonText("Azzera").onClick(async () => {
          s.spendTotal = 0;
          s.spendMonth = month;
          await save();
          this.display();
        })
      );

    this.renderHandwriting(containerEl);

    new Setting(containerEl)
      .setName("Parole frequenti")
      .setDesc("Nomi, sigle e parole che usi spesso, separati da virgole: aiutano a leggere il corsivo quando è ambiguo.")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setPlaceholder("Francesco, Obsidian, riunione, fattura…")
          .setValue(s.vocabulary)
          .onChange(async (v) => {
            s.vocabulary = v;
            await save();
          });
      });

    new Setting(containerEl)
      .setName("Parole da non usare")
      .setDesc("Letture sbagliate che la tua grafia fa venire fuori (es. «violeo» al posto di «video», perché la «d» staccata sembra «ol»), separate da virgole. Claude non le userà; se compaiono lo stesso, il plugin le sostituisce con la parola frequente più simile.")
      .addTextArea((t) => {
        t.inputEl.rows = 2;
        t.setPlaceholder("violeo, violes…")
          .setValue(s.blacklist ?? "")
          .onChange(async (v) => {
            s.blacklist = v;
            await save();
          });
      });

    new Setting(containerEl)
      .setName("Trascrizione automatica")
      .setDesc("Dopo ogni sincronizzazione trascrive le pagine con tratti nuovi: una chiamata per pagina, solo il testo nuovo viene aggiunto alla nota.")
      .addToggle((t) =>
        t.setValue(s.autoTranscribe).onChange(async (v) => {
          s.autoTranscribe = v;
          await save();
        })
      );

    this.renderRules(containerEl);

    this.renderCalendar(containerEl);

    new Setting(containerEl).setName("Penna").setHeading();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "La memoria della penna è l'archivio: il plugin si collega solo per leggere le pagine cambiate e poi si scollega, così la penna continua a salvare tutto. " +
        "Il plugin non tiene copie dei tratti: ricorda solo fin dove ha trascritto. Niente viene cancellato dalla penna se non lo scegli tu.",
    });

    new Setting(containerEl)
      .setName("Sincronizza da sola quando accendi la penna")
      .setDesc("Il plugin controlla ogni 20 secondi circa se la penna è accesa (tappo aperto): appena la trova legge la memoria, trascrive e si scollega.")
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Mentre la penna è accesa, sincronizza ogni (minuti)")
      .setDesc("Così il testo arriva anche mentre scrivi. Ogni sincronizzazione dura pochi secondi.")
      .addSlider((sl) =>
        sl
          .setLimits(2, 30, 1)
          .setValue(s.syncEveryMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.syncEveryMinutes = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Memoria della penna")
      .setDesc("Vedi le pagine salvate nella penna, recuperale in Obsidian o cancellale.")
      .addButton((b) => b.setButtonText("Apri").onClick(() => void this.plugin.openMemory()));

    new Setting(containerEl)
      .setName("Rileggi tutto dalla penna")
      .setDesc("Riscarica tutte le pagine e ridisegna le immagini (non ritrascrive il testo già trascritto).")
      .addButton((b) =>
        b.setButtonText("Rileggi").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.syncNow({ all: true });
          b.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName("Log dettagliato dell'SDK")
      .setDesc("Scrive i pacchetti Bluetooth nella console sviluppatore (Ctrl+Shift+I). Utile per il debug.")
      .addToggle((t) =>
        t.setValue(s.sdkDebug).onChange(async (v) => {
          s.sdkDebug = v;
          this.plugin.pen.setSdkDebug(v);
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Copie di debug delle trascrizioni")
      .setDesc("Salva in NeoPen/_debug l'immagine mandata a Claude, la richiesta, la risposta e il registro. Utile per capire un errore di trascrizione; poi spegnilo.")
      .addToggle((t) =>
        t.setValue(!!s.debugDump).onChange(async (v) => {
          s.debugDump = v;
          await save();
        })
      );

  }
}
