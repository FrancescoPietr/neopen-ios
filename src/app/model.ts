// The app's brain: ties together the native Bluetooth module, the pen session, the archive and uploads to the PC.
// It starts as soon as JavaScript loads (also when iOS relaunches the app in the background for the pen).
import NeoPenBle, { BleState } from "../../modules/neopen-ble";
import { AppState } from "react-native";
import { fromBase64, toBase64 } from "../core/bytes";
import { PenSession, SessionError, SessionNote } from "../core/session";
import { RelayClient } from "../core/relay";
import { BackgroundRelayClient } from "./backgroundRelay";
import { PhoneEvents } from "./phoneEvents";
import { PageStore } from "../core/store";
import { Uploader } from "../core/uploader";
import { checkClaudeTests, startClaudeTest } from "./bgtest";
import { DevicePageFiles, LogFile, readJson, writeJson } from "./files";

export interface Settings {
  scriptURL: string;
  secret: string;
  live: boolean;
  deleteAfterDownload: boolean;
  skipUnchanged: boolean;
  penPassword: string;
  /** Claude key (on this phone only): appointments to the calendar and the background test. */
  testKey: string;
  /** Tasks with a time go to the calendar straight from the phone. */
  phoneEvents: boolean;
}

const DEFAULT_SETTINGS: Settings = { scriptURL: "", secret: "", live: true, deleteAfterDownload: false, skipUnchanged: false, penPassword: "", testKey: "", phoneEvents: false };

export type Phase = { kind: "idle" } | { kind: "handshake" } | { kind: "syncing"; done: number; total: number } | { kind: "listening" } | { kind: "needsPassword" };

export interface LogLine {
  id: number;
  time: Date;
  text: string;
}

/** Everything the UI shows (a new object at every change, for useSyncExternalStore). */
export interface Snapshot {
  bleState: BleState;
  penName: string;
  hasPen: boolean;
  phase: Phase;
  battery: number | null;
  pagesCount: number;
  pendingCount: number;
  uploading: boolean;
  lastUpload: Date | null;
  uploadError: string | null;
  lastProblem: string | null;
  configured: boolean;
  settings: Settings;
  log: LogLine[];
}

class AppModel {
  readonly store = new PageStore(new DevicePageFiles());
  readonly uploader = new Uploader(this.store);
  private settings: Settings = readJson("impostazioni.json", DEFAULT_SETTINGS);
  readonly phoneEvents = new PhoneEvents(
    this.store,
    () => ({ enabled: this.settings.phoneEvents, apiKey: this.settings.testKey, scriptURL: this.settings.scriptURL.trim(), secret: this.settings.secret.trim() }),
    (m) => this.write(m)
  );
  private session: PenSession | null = null;
  private logFile = new LogFile();
  private logLines: LogLine[] = [];
  private logId = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private bleState: BleState = "starting";
  private penName = "";
  private hasPen = false;
  private phase: Phase = { kind: "idle" };
  private battery: number | null = null;
  private lastProblem: string | null = null;
  private started = false;

  constructor() {
    this.snap = this.makeSnapshot();
  }

  /** Called once at startup (index.ts). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.uploader.log = (m) => this.write(m);
    this.uploader.changed = () => this.emit();
    this.uploader.keepAlive = (name) => {
      const id = NeoPenBle.beginBackgroundTask(name);
      return () => NeoPenBle.endBackgroundTask(id);
    };
    this.configureUploader();
    this.store.subscribe(() => this.emit());
    // background Claude test: report what finished while the app was asleep
    // and answers for the appointments (calendar from the phone)
    setTimeout(() => {
      this.checkTests();
      this.phoneEvents.poll();
      this.phoneEvents.retryTodos();
    }, 3000);
    setInterval(() => {
      this.checkTests();
      this.phoneEvents.poll();
    }, 4000);

    NeoPenBle.addListener("onLog", (e) => this.write(e.message));
    NeoPenBle.addListener("onState", (e) => {
      this.bleState = e.state;
      this.penName = e.penName;
      this.hasPen = !!e.penName || this.hasPen;
      if (e.state === "noPen") this.hasPen = false;
      this.emit();
    });
    NeoPenBle.addListener("onReady", () => this.penReady());
    NeoPenBle.addListener("onData", (e) => this.session?.receive(fromBase64(e.base64)));
    NeoPenBle.addListener("onClosed", () => this.penClosed());
    void NeoPenBle.getState().then((s) => {
      this.bleState = s.state;
      this.penName = s.penName;
      this.hasPen = s.hasPen;
      this.write(`App avviata${s.launchedForBluetooth ? " da iOS per la penna (in background)" : ""}.`);
      this.emit();
    });
    if (this.store.pendingUploads.length) this.uploader.schedule(2);
  }

  // ---------------------------------------------------------------- pen

  private penReady(): void {
    const s = new PenSession(this.store, {
      live: this.settings.live,
      deleteAfterDownload: this.settings.deleteAfterDownload,
      skipUnchanged: this.settings.skipUnchanged,
      password: this.settings.penPassword,
    });
    s.link = { send: (bytes) => NeoPenBle.send(toBase64(bytes)) };
    s.log = (m) => this.write(m);
    s.note = (n) => this.sessionNote(n);
    this.session = s;
    this.phase = { kind: "handshake" };
    this.emit();
    const id = NeoPenBle.beginBackgroundTask("scaricamento dalla penna");
    void (async () => {
      try {
        await s.start();
        await s.syncMemory();
        this.lastProblem = null;
        this.phase = this.settings.live ? { kind: "listening" } : { kind: "idle" };
        this.emit();
        await this.uploader.flush();
        // without live mode there's no need to stay connected: the pen keeps everything in memory for next time
        if (!this.settings.live) NeoPenBle.disconnect();
      } catch (e) {
        if (e instanceof SessionError && e.kind === "passwordNeeded") {
          this.phase = { kind: "needsPassword" };
          this.lastProblem = e.message;
          this.write(e.message);
        } else if (!s.closed) {
          this.lastProblem = e instanceof Error ? e.message : String(e);
          this.write(`Collegamento interrotto: ${this.lastProblem}`);
          NeoPenBle.disconnect();
        }
        this.emit();
      } finally {
        NeoPenBle.endBackgroundTask(id);
      }
    })();
  }

  private penClosed(): void {
    this.session?.linkClosed();
    this.session = null;
    if (this.phase.kind !== "needsPassword") this.phase = { kind: "idle" };
    this.emit();
    // what arrived so far leaves for the PC right away
    this.uploader.schedule(1);
    // test: can the app write into the Obsidian vault right now (often with the phone locked)?
    this.vaultTest("penna spenta");
    // pen off = you stopped writing: appointments go to the calendar now
    const task = NeoPenBle.beginBackgroundTask("appuntamenti");
    try {
      this.phoneEvents.kick();
    } catch (e) {
      this.write(`Eventi dal telefono: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      NeoPenBle.endBackgroundTask(task);
    }
  }

  private sessionNote(n: SessionNote): void {
    switch (n.type) {
      case "authorized":
        this.write(`Penna pronta: ${n.version.deviceName} (firmware ${n.version.firmware}).`);
        break;
      case "battery":
        this.battery = n.level;
        break;
      case "syncProgress":
        if (n.done < n.total) this.phase = { kind: "syncing", done: n.done, total: n.total };
        break;
      case "pageUpdated":
        this.uploader.schedule(4);
        this.phoneEvents.strokesArrived();
        break;
      case "syncFinished":
        this.write(n.pages > 0 ? `Memoria della penna letta: ${n.pages} pagine con ${n.newStrokes} tratti nuovi.` : "Memoria della penna letta: niente di nuovo.");
        break;
      case "powerOff":
        break;
    }
    this.emit();
  }

  // ---------------------------------------------------------------- commands from the UI

  searchPen = () => NeoPenBle.searchPen();
  stopSearch = () => NeoPenBle.stopSearch();
  forgetPen = () => NeoPenBle.forgetPen();
  sendNow = () => void this.uploader.flush();

  /** Tasks without a time written today: read again and sent (for those that did not reach Todoist). */
  resendTodayTodos = () => {
    const n = this.phoneEvents.resendToday();
    if (!n) this.write("Niente scritto oggi da rileggere (o mancano chiave e script nelle impostazioni).");
  };

  /** Name of the chosen vault folder (or null). */
  vaultName(): string | null {
    try {
      return NeoPenBle.vaultFolderName();
    } catch {
      return null;
    }
  }

  pickVault = async (): Promise<string | null> => {
    const name = await NeoPenBle.pickVaultFolder();
    if (name) this.write(`Cartella del vault scelta: «${name}».`);
    this.emit();
    return name;
  };

  /** Test: writes NeoPen/_telefono/prova-scrittura.md in the vault and logs whether it worked and the app state. */
  vaultTest = (why = "a mano") => {
    if (!this.vaultName()) return;
    const now = new Date();
    const state = AppState.currentState;
    const err = NeoPenBle.writeVaultFile(
      "NeoPen/_telefono/prova-scrittura.md",
      `Prova di scrittura dall'app Neo Pen\n\n- quando: ${now.toLocaleString("it-IT")}\n- motivo: ${why}\n- app: ${state}\n`
    );
    this.write(err ? `Vault: scrittura NON riuscita (${why}, app ${state}): ${err}` : `Vault: file di prova scritto (${why}, app ${state === "active" ? "aperta" : "in background"}).`);
  };

  /** Test: a Claude call that iOS finishes with the phone locked (see bgtest.ts). */
  private lastTest = 0;
  testClaude = () => {
    if (Date.now() - this.lastTest < 60_000) {
      this.write("Prova Claude: ne è già partita una, aspetta un minuto.");
      return;
    }
    this.lastTest = Date.now();
    const key = this.settings.testKey.trim();
    this.write(key ? startClaudeTest(key) : "Prova Claude: inserisci prima la chiave.");
  };

  /** Reports finished background tests (also those finished while the app was asleep). */
  checkTests = () => checkClaudeTests((m) => this.write(m));

  resendAll = () => {
    this.store.markAllUnsent();
    this.write("Tutte le pagine ripartono verso il PC.");
    void this.uploader.flush();
  };

  testScript = async (): Promise<string> => {
    const c = this.uploader.client;
    if (!(c instanceof RelayClient)) return "Mancano indirizzo o chiave dello script.";
    try {
      await c.ping();
      return "Script raggiungibile: tutto a posto.";
    } catch (e) {
      return `Script: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /** Pastes URL and secret from the «Collegamento iPhone» note copied in Obsidian. */
  pasteConfig = (text: string): boolean => {
    const url = text.match(/https:\/\/script\.google\.com\/[^\s`"']+\/exec/)?.[0];
    const secret = text.match(/\b[0-9a-f]{24,64}\b/)?.[0];
    if (url || secret) this.update({ ...(url ? { scriptURL: url } : {}), ...(secret ? { secret } : {}) });
    return !!(url || secret);
  };

  update = (patch: Partial<Settings>) => {
    this.settings = { ...this.settings, ...patch };
    writeJson("impostazioni.json", this.settings);
    this.configureUploader();
    // just turned on: set the starting point (what is already written is not sent)
    if (patch.phoneEvents) this.phoneEvents.kick();
    this.emit();
  };

  get logPath(): string {
    return this.logFile.file.uri;
  }

  private configureUploader(): void {
    const url = this.settings.scriptURL.trim();
    const secret = this.settings.secret.trim();
    this.uploader.client = RelayClient.looksValid(url, secret) ? new BackgroundRelayClient(url, secret) : null;
  }

  // ---------------------------------------------------------------- log and UI state

  write(text: string): void {
    const line = { id: ++this.logId, time: new Date(), text };
    this.logLines = [...this.logLines.slice(-399), line];
    const t = line.time;
    const pad = (n: number) => String(n).padStart(2, "0");
    this.logFile.append(`${pad(t.getDate())}/${pad(t.getMonth() + 1)} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}  ${text}`);
    this.emit();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private emit(): void {
    this.snap = this.makeSnapshot();
    for (const fn of this.listeners) fn();
  }

  private makeSnapshot(): Snapshot {
    return {
      bleState: this.bleState,
      penName: this.penName,
      hasPen: this.hasPen,
      phase: this.phase,
      battery: this.battery,
      pagesCount: this.store.pages.size,
      pendingCount: this.store.pendingUploads.length,
      uploading: this.uploader.busy,
      lastUpload: this.uploader.lastSuccess,
      uploadError: this.uploader.lastError,
      lastProblem: this.lastProblem,
      configured: this.uploader.client !== null,
      settings: this.settings,
      log: this.logLines,
    };
  }
}

export const model = new AppModel();
