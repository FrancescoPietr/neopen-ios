// Collegamento Bluetooth (Web Bluetooth) con la Neo Smartpen, basato sull'SDK web ufficiale.
// La memoria della penna è l'archivio: il plugin si collega, legge le pagine cambiate e si scollega.
// (Con la penna collegata in tempo reale la penna NON salva i tratti: per questo il live è opzionale.)

import PenController from "../../vendor/web_pen_sdk/PenCotroller/PenController";
import PenMessageType from "../../vendor/web_pen_sdk/API/PenMessageType";
import * as NLog from "../../vendor/web_pen_sdk/Util/NLog";
import { Emitter } from "../events";
import { PageKey, PenStatus, Stroke, cleanPts, pageId, sameKey, validKey } from "../types";
import { ChooserHandle } from "./electronChooser";

// UUID dei servizi BLE della penna (da PenHelper dell'SDK)
// UUID completi (non numeri): Bluefy su iPhone rifiuta gli alias numerici a 16 bit.
const SERVICE_16 = "000019f1-0000-1000-8000-00805f9b34fb";
const NOTIFY_16 = "00002ba1-0000-1000-8000-00805f9b34fb";
const WRITE_16 = "00002ba0-0000-1000-8000-00805f9b34fb";
const SERVICE_128 = "4f99f138-9d53-5bfa-9e50-b147491afe68";
const NOTIFY_128 = "64cd86b1-2256-5aeb-9f04-2caf6c60ae57";
const WRITE_128 = "8bc8cc7d-88ca-56b0-af9a-9bf514d0d61a";

/** Testo leggibile di un errore qualsiasi (Bluefy a volte rifiuta con un semplice numero). */
export function describeError(e: unknown): string {
  if (e == null) return "errore sconosciuto";
  if (typeof e !== "object") return String(e);
  const x = e as { name?: string; message?: string; code?: unknown };
  const parts = [x.name, x.message, x.code != null ? `codice ${x.code}` : ""].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const DOT_DOWN = 0;
const DOT_MOVE = 1;
const DOT_UP = 2;

export interface LiveDot {
  key: PageKey;
  x: number;
  y: number;
  f: number;
  type: number;
}

export type PenEvents = {
  status: PenStatus;
  log: string;
  /** Punto in tempo reale (per disegnare mentre scrivi). */
  dot: LiveDot;
  /** Tratto ricevuto in tempo reale (solo con la penna collegata in modalità live). */
  stroke: { key: PageKey; stroke: Stroke; source: "live" | "offline" };
  offlineProgress: { note: number; page: number; percent: number };
  passwordRequest: { retry: number; reset: number };
};

/** Pagina salvata nella memoria della penna, con il numero di tratti che la penna dichiara. */
export interface MemoryPage {
  key: PageKey;
}

export interface DownloadedPage {
  key: PageKey;
  /** Numero di tratti dichiarato dalla penna per la pagina (-1 se sconosciuto). */
  count: number;
  /** Dimensione dei dati dichiarata dalla penna (-1 se sconosciuta). */
  bytes?: number;
  strokes: Stroke[];
}

export interface SyncPlan {
  /** Scaricare questa pagina? (la penna ha appena detto quanti tratti contiene) */
  shouldDownload: (key: PageKey, count: number, bytes: number) => boolean;
  /** Pagine da scaricare comunque dopo il primo giro (es. le altre pagine della stessa nota). */
  extra?: (downloaded: PageKey[]) => PageKey[];
}

export interface SyncResult {
  /** Tutte le pagine presenti nella memoria della penna. */
  memory: PageKey[];
  downloaded: DownloadedPage[];
  /** Pagine saltate perché invariate. */
  skipped: number;
}

export interface ConnectOptions {
  /** Niente messaggi nel registro se la penna non c'è (tentativi automatici). */
  quiet?: boolean;
  /** Ricevi i tratti in tempo reale (la penna allora NON li salva in memoria). */
  live?: boolean;
  /** Durata massima della ricerca (ms). */
  scanMs?: number;
  /** Usa la penna già trovata in questa sessione, senza una nuova ricerca. */
  reuse?: boolean;
  /** Collegati a questa penna (già scelta altrove, es. dal selettore di Bluefy). */
  device?: BluetoothDevice;
}

/** Esegue una funzione come se l'utente avesse cliccato (serve a requestDevice nei tentativi automatici). */
export type GestureRunner = <T>(fn: () => Promise<T>) => Promise<T>;

const PEN_NAME = /neo|smartpen|nwp|m1|lamy/i;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function keyOf(dot: any): PageKey {
  const p = dot.pageInfo ?? {};
  return { section: p.section ?? 0, owner: p.owner ?? 0, note: p.book ?? p.note ?? 0, page: p.page ?? 0 };
}

export class PenConnection extends Emitter<PenEvents> {
  private device: BluetoothDevice | null = null;
  /** Ultima penna trovata: per ricollegarsi senza una nuova ricerca. */
  private lastDevice: BluetoothDevice | null = null;
  private controller: PenController | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private status: PenStatus = { state: "disconnesso" };
  /** Vero mentre apriamo la connessione GATT (le disconnessioni lì dentro si riprovano). */
  private connecting = false;
  private live = false;

  // tratto live in costruzione
  private current: { key: PageKey; stroke: Stroke } | null = null;

  // attese di messaggi dalla penna
  private waiters: { match: (type: number, args: any) => boolean; resolve: (v: { type: number; args: any }) => void }[] = [];
  private authWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Tratti raccolti durante lo scaricamento di una pagina. */
  private collecting: Stroke[] | null = null;
  private collectKey: PageKey | null = null;
  /** Una sola operazione alla volta sulla penna. */
  private op: Promise<unknown> = Promise.resolve();

  constructor(private chooser: ChooserHandle, private gesture?: GestureRunner) {
    super();
  }

  get isConnected(): boolean {
    return this.status.state === "connesso" || this.status.state === "scaricamento";
  }

  get hasKnownDevice(): boolean {
    return !!this.lastDevice;
  }

  getStatus(): PenStatus {
    return this.status;
  }

  setSdkDebug(on: boolean): void {
    NLog.setDebug(on);
  }

  private log(msg: string): void {
    this.emit("log", msg);
  }

  private setStatus(patch: Partial<PenStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  /** Esegue le operazioni sulla penna una alla volta. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.op.then(fn, fn);
    this.op = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- connessione

  /** Si collega e aspetta che la penna autorizzi la connessione. */
  async connect(opts: ConnectOptions = {}): Promise<void> {
    if (this.isConnected) return;
    const bt = (navigator as any).bluetooth as Bluetooth | undefined;
    if (!bt) throw new Error("Web Bluetooth non disponibile in questa versione di Obsidian.");
    this.live = !!opts.live;

    let device: BluetoothDevice;
    if (opts.device) {
      device = opts.device;
    } else if (opts.reuse && this.lastDevice) {
      device = this.lastDevice;
    } else {
      this.setStatus({ state: "ricerca" });
      if (!opts.quiet) this.log("Cerco la penna… (accendila e tienila vicina; chiudi Neo Studio sul telefono)");
      try {
        device = await this.requestPen(opts.scanMs ?? 30000, !!opts.quiet);
      } catch (e) {
        this.setStatus({ state: "disconnesso" });
        throw e;
      }
    }

    this.device = device;
    this.lastDevice = device;
    this.setStatus({ state: "connessione", name: device.name ?? "Neo Smartpen" });
    if (!opts.quiet) this.log(`Trovata: ${device.name ?? device.id}. Mi collego…`);
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);

    const authorized = new Promise<void>((resolve, reject) => (this.authWait = { resolve, reject }));
    authorized.catch(() => undefined);
    try {
      // A volte la penna appena accesa chiude la connessione mentre ci colleghiamo
      // ("GATT Server is disconnected"): riprova da solo prima di arrendersi.
      this.connecting = true;
      const attempts = opts.quiet ? 1 : 3;
      let chars: { notify: BluetoothRemoteGATTCharacteristic; write: BluetoothRemoteGATTCharacteristic } | null = null;
      for (let attempt = 1; !chars; attempt++) {
        try {
          const server = await withTimeout(device.gatt!.connect(), 12000, "la penna non risponde");
          chars = await this.bindCharacteristics(server, !!opts.quiet);
        } catch (e) {
          if (attempt >= attempts) throw e;
          if (!opts.quiet) this.log(`La penna ha chiuso la connessione, riprovo (${attempt + 1}/${attempts})…`);
          await sleep(1200);
        }
      }
      this.connecting = false;
      this.notifyChar = chars.notify;
      this.writeChar = chars.write;
      this.setupController(device);
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener("characteristicvaluechanged", this.onNotify);
      this.controller!.OnConnected(); // avvia l'handshake (versione → impostazioni → autorizzazione)
      if (!opts.quiet) this.log("Canale aperto, attendo l'autorizzazione della penna…");
      await withTimeout(authorized, 20000, "la penna non ha autorizzato la connessione");
    } catch (e) {
      this.connecting = false;
      this.authWait = null;
      if (!opts.quiet) this.log(`Connessione fallita: ${(e as Error)?.message ?? e}`);
      try {
        // anche se il collegamento è ancora "in corso": va annullato, altrimenti la penna
        // resterebbe collegata senza nessuno che ascolta (e non salverebbe più in memoria)
        device.gatt?.disconnect();
      } catch {
        /* ignora */
      }
      this.cleanup();
      throw e;
    }
  }

  /** Cerca la penna: prima tra quelle già permesse, poi con una ricerca Bluetooth. */
  private async requestPen(scanMs: number, quiet: boolean): Promise<BluetoothDevice> {
    const bt = (navigator as any).bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    try {
      const known = (await bt.getDevices?.()) ?? [];
      const d = known.find((x) => PEN_NAME.test(x.name ?? ""));
      if (d) return d;
    } catch {
      /* non supportato */
    }
    this.chooser.setQuiet(quiet);
    const timeout = window.setTimeout(() => {
      if (!quiet) this.log(`Nessuna penna trovata entro ${Math.round(scanMs / 1000)} secondi: annullo la ricerca.`);
      this.chooser.cancel();
    }, scanMs);
    const optionalServices = [SERVICE_16, SERVICE_128];
    // alcune penne non annunciano il servizio: se il filtro per servizio fallisce si riprova per nome
    const variants: RequestDeviceOptions[] = [
      { filters: [{ services: [SERVICE_16] }, { services: [SERVICE_128] }], optionalServices },
      { filters: ["Neo", "NWP", "Smartpen", "LAMY"].map((namePrefix) => ({ namePrefix })), optionalServices },
    ];
    try {
      let last: unknown = null;
      for (const opts of variants) {
        try {
          const run = () => bt.requestDevice(opts);
          return this.gesture ? await this.gesture(run) : await run();
        } catch (e) {
          last = e;
          // annullata dall'utente o dal tempo massimo: inutile riprovare
          if (/cancel|NotFoundError|abort/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`)) break;
        }
      }
      throw last;
    } catch (e) {
      throw new Error(`Ricerca fallita: ${describeError(e)}`);
    } finally {
      window.clearTimeout(timeout);
      this.chooser.setQuiet(false);
    }
  }

  private async bindCharacteristics(server: BluetoothRemoteGATTServer, quiet: boolean) {
    try {
      const s = await server.getPrimaryService(SERVICE_16);
      const notify = await s.getCharacteristic(NOTIFY_16);
      const write = await s.getCharacteristic(WRITE_16);
      if (!quiet) this.log("Servizio penna (16 bit) trovato.");
      return { notify, write };
    } catch {
      const s = await server.getPrimaryService(SERVICE_128);
      const notify = await s.getCharacteristic(NOTIFY_128);
      const write = await s.getCharacteristic(WRITE_128);
      if (!quiet) this.log("Servizio penna (128 bit) trovato.");
      return { notify, write };
    }
  }

  private setupController(device: BluetoothDevice): void {
    const c = new PenController();
    c.device = device;
    c.addWrite((data: Uint8Array) => this.enqueueWrite(data));
    c.addCallback(
      (_ctrl, dot) => this.onDot(dot),
      (_ctrl, type, args) => this.onMessage(type, args)
    );
    this.controller = c;
  }

  /** Le scritture GATT vanno serializzate: due in parallelo danno "operation already in progress". */
  private enqueueWrite(data: Uint8Array): void {
    const char = this.writeChar;
    if (!char) return;
    const buf = new Uint8Array(data);
    this.writeChain = this.writeChain
      .then(() => char.writeValue(buf))
      .catch(async (e) => {
        await sleep(300);
        try {
          await char.writeValue(buf);
        } catch {
          this.log(`Scrittura verso la penna fallita: ${(e as Error)?.message ?? e}`);
        }
      });
  }

  private onNotify = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || !this.controller) return;
    const arr = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.controller.putData(Array.from(arr) as any);
  };

  private onGattDisconnected = (): void => {
    if (this.connecting) return; // durante il collegamento ci pensa il ciclo di tentativi
    this.log("Penna disconnessa.");
    this.finishCurrentStroke();
    try {
      this.controller?.OnDisconnected();
    } catch {
      /* ignora */
    }
    this.cleanup();
  };

  disconnect(): void {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.cleanup();
  }

  private cleanup(): void {
    this.notifyChar?.removeEventListener("characteristicvaluechanged", this.onNotify);
    this.device?.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    this.device = null;
    this.controller = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.current = null;
    this.collecting = null;
    this.authWait?.reject(new Error("penna disconnessa"));
    this.authWait = null;
    // chi aspettava un messaggio non lo riceverà più
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve({ type: -1, args: null });
    this.status = { state: "disconnesso", name: this.status.name };
    this.emit("status", this.status);
  }

  inputPassword(pw: string): void {
    this.controller?.InputPassword(pw);
  }

  // ---------------------------------------------------------------- messaggi SDK

  /** Aspetta un messaggio della penna che soddisfi `match` (type -1 = disconnessa, -2 = tempo scaduto). */
  private waitMsg(match: (type: number, args: any) => boolean, ms: number): Promise<{ type: number; args: any }> {
    return new Promise((resolve) => {
      const w = {
        match,
        resolve: (v: { type: number; args: any }) => {
          window.clearTimeout(timer);
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(v);
        },
      };
      const timer = window.setTimeout(() => w.resolve({ type: -2, args: null }), ms);
      this.waiters.push(w);
    });
  }

  private onMessage(type: number, args: any): void {
    switch (type) {
      case PenMessageType.PEN_SETTING_INFO:
        this.setStatus({
          battery: args?.Battery,
          usedMemory: args?.UsedMem,
          maxForce: args?.MaxForce,
        });
        break;

      case PenMessageType.PEN_PASSWORD_REQUEST:
        this.log("La penna è protetta da password.");
        this.emit("passwordRequest", { retry: args?.RetryCount ?? 0, reset: args?.ResetCount ?? 0 });
        break;

      case PenMessageType.PEN_AUTHORIZED: {
        const info = this.controller?.info;
        this.log(
          `Penna collegata${info?.DeviceName ? `: ${info.DeviceName}` : ""}` +
            `${info?.FirmwareVersion ? ` (firmware ${info.FirmwareVersion})` : ""}.`
        );
        // orologio della penna allineato al PC: serve per l'orario dei tratti
        this.controller?.SetRtcTime();
        // in tempo reale solo se richiesto: altrimenti la penna continua a salvare tutto in memoria
        if (this.live) this.controller?.RequestAvailableNotes(null as any, null as any, null);
        this.setStatus({ state: "connesso" });
        this.authWait?.resolve();
        this.authWait = null;
        break;
      }

      case PenMessageType.EVENT_LOW_BATTERY:
        this.log(`Batteria scarica: ${args}%`);
        this.setStatus({ battery: args });
        break;

      case PenMessageType.EVENT_POWER_OFF:
        this.log("La penna si è spenta.");
        break;

      case PenMessageType.PEN_CONNECTION_FAILURE_BTDUPLICATE:
        this.log("La penna risulta già collegata a un altro dispositivo.");
        break;

      case PenMessageType.OFFLINE_DATA_SEND_SUCCESS:
        this.onOfflineStrokes(args ?? []);
        break;

      case PenMessageType.OFFLINE_DATA_SEND_STATUS: {
        const percent = Math.min(100, Math.round(Number(args) || 0));
        if (this.collectKey) this.emit("offlineProgress", { note: this.collectKey.note, page: this.collectKey.page, percent });
        break;
      }

      default:
        break;
    }
    for (const w of [...this.waiters]) {
      if (w.match(type, args)) {
        w.resolve({ type, args });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- tratti live

  // Attenzione all'SDK: il PEN_DOWN è un punto "segnaposto" con x = y = -1 e arriva
  // PRIMA dell'informazione sulla pagina (che può ancora essere -1 o quella vecchia).
  // Le coordinate vere e la pagina giusta arrivano con i PEN_MOVE; il PEN_UP è una
  // copia dell'ultimo punto. Quindi: chiave e punti si prendono solo dai MOVE validi.
  private onDot(dot: any): void {
    const type: number = dot.dotType;
    if (type === DOT_DOWN) {
      this.finishCurrentStroke();
      this.current = {
        key: { section: -1, owner: -1, note: -1, page: -1 },
        stroke: { t: dot.timeStamp || Date.now(), tip: dot.penTipType ?? 0, color: dot.color ?? 0, pts: [] },
      };
      return;
    }
    if (type === DOT_UP) {
      this.finishCurrentStroke();
      return;
    }
    if (type !== DOT_MOVE) return; // hover, info, errori

    const key = keyOf(dot);
    if (!validKey(key) || !(dot.x >= 0 && dot.y >= 0)) return;

    if (!this.current) {
      // MOVE senza DOWN (può succedere se il DOWN è andato perso)
      this.current = {
        key,
        stroke: { t: dot.timeStamp || Date.now(), tip: dot.penTipType ?? 0, color: dot.color ?? 0, pts: [] },
      };
    }
    const first = this.current.stroke.pts.length === 0;
    this.current.key = key;
    this.current.stroke.pts.push(dot.x, dot.y, dot.f);
    this.emit("dot", { key, x: dot.x, y: dot.y, f: dot.f, type: first ? DOT_DOWN : DOT_MOVE });
  }

  private finishCurrentStroke(): void {
    const cur = this.current;
    this.current = null;
    if (cur && validKey(cur.key) && cur.stroke.pts.length >= 3) {
      this.emit("dot", { key: cur.key, x: 0, y: 0, f: 0, type: DOT_UP });
      this.emit("stroke", { key: cur.key, stroke: cur.stroke, source: "live" });
    }
  }

  // ---------------------------------------------------------------- memoria della penna

  /** Elenco delle pagine salvate nella memoria della penna. */
  async listMemory(): Promise<PageKey[]> {
    const c = this.controller;
    if (!c || !this.isConnected) throw new Error("penna non collegata");
    const wNotes = this.waitMsg((t) => t === PenMessageType.OFFLINE_DATA_NOTE_LIST, 10000);
    c.RequestOfflineNoteList(0, 0);
    const notes = (await wNotes).args as { Section: number; Owner: number; Note: number }[] | null;
    if (!Array.isArray(notes)) throw new Error("la penna non ha mandato l'elenco dei quaderni");
    const out: PageKey[] = [];
    for (const n of notes) {
      const wPages = this.waitMsg(
        (t, a) => t === PenMessageType.OFFLINE_DATA_PAGE_LIST && a?.Note === n.Note && a?.Owner === n.Owner,
        10000
      );
      c.RequestOfflinePageList(n.Section, n.Owner, n.Note);
      const r = await wPages;
      if (r.type === -1) throw new Error("penna disconnessa");
      const pages: number[] = Array.isArray(r.args?.Pages) ? r.args.Pages : [];
      for (const page of pages) out.push({ section: n.Section, owner: n.Owner, note: n.Note, page });
    }
    return out.filter(validKey).sort((a, b) => a.note - b.note || a.page - b.page);
  }

  /**
   * Scarica una pagina dalla memoria della penna SENZA cancellarla.
   * Se `decide` risponde false (pagina invariata), il trasferimento viene interrotto subito.
   */
  async downloadPage(key: PageKey, decide?: (count: number, bytes: number) => boolean): Promise<DownloadedPage | null> {
    const c = this.controller;
    if (!c || !this.isConnected) throw new Error("penna non collegata");
    const isStart = (t: number) => t === PenMessageType.OFFLINE_DATA_SEND_START || t === PenMessageType.OFFLINE_DATA_SEND_FAILURE;
    const wStart = this.waitMsg(isStart, 10000);
    (c as any).abortOfflineTransfer = false;
    this.collecting = [];
    this.collectKey = key;
    try {
      c.RequestOfflineData(key.section, key.owner, key.note, false, [key.page]);
      const first = await wStart;
      if (first.type === -1) throw new Error("penna disconnessa");
      if (first.type !== PenMessageType.OFFLINE_DATA_SEND_START) return { key, count: 0, strokes: [] };
      const count = Number(first.args?.stroke);
      const known = Number.isFinite(count) ? count : -1;
      const size = Number(first.args?.bytes);
      const bytes = Number.isFinite(size) ? size : -1;
      const done = (t: number, a: any) =>
        (t === PenMessageType.OFFLINE_DATA_SEND_STATUS && Number(a) >= 100) || t === PenMessageType.OFFLINE_DATA_SEND_FAILURE;
      if (decide && !decide(known, bytes)) {
        // pagina invariata: chiediamo alla penna di interrompere l'invio
        (c as any).abortOfflineTransfer = true;
        await this.waitMsg(done, 8000);
        await sleep(400);
        return null;
      }
      // aspetta la fine (il tempo massimo si rinnova a ogni pacchetto ricevuto)
      for (;;) {
        const r = await this.waitMsg((t, a) => done(t, a) || t === PenMessageType.OFFLINE_DATA_SEND_STATUS, 15000);
        if (r.type === -1) throw new Error("penna disconnessa durante lo scaricamento");
        if (r.type === -2) throw new Error(`la penna ha smesso di mandare la pagina ${key.page}`);
        if (done(r.type, r.args)) break;
      }
      await sleep(250);
      const strokes = (this.collecting ?? []).sort((a, b) => a.t - b.t);
      return { key, count: known, bytes, strokes };
    } finally {
      (c as any).abortOfflineTransfer = false;
      this.collecting = null;
      this.collectKey = null;
    }
  }

  /**
   * Sincronizzazione: legge l'elenco delle pagine nella penna e scarica solo quelle cambiate
   * (più quelle chieste da `plan.extra`). Non cancella nulla dalla penna.
   */
  async sync(plan: SyncPlan): Promise<SyncResult> {
    this.setStatus({ state: "scaricamento" });
    try {
      const memory = await this.listMemory();
      const downloaded: DownloadedPage[] = [];
      let skipped = 0;
      for (const key of memory) {
        const r = await this.downloadPage(key, (count, bytes) => plan.shouldDownload(key, count, bytes));
        if (r) downloaded.push(r);
        else skipped++;
      }
      const have = new Set(downloaded.map((d) => pageId(d.key)));
      const inPen = new Set(memory.map(pageId));
      for (const key of plan.extra?.(downloaded.map((d) => d.key)) ?? []) {
        const id = pageId(key);
        if (have.has(id) || !inPen.has(id)) continue;
        const r = await this.downloadPage(key);
        if (r) {
          downloaded.push(r);
          have.add(id);
          skipped--;
        }
      }
      return { memory, downloaded, skipped: Math.max(0, skipped) };
    } finally {
      if (this.controller) this.setStatus({ state: "connesso" });
    }
  }

  /** Cancella dalla memoria della penna le pagine indicate. */
  async deletePages(keys: PageKey[]): Promise<number> {
    const c = this.controller;
    if (!c || !this.isConnected) throw new Error("penna non collegata");
    const byNote = new Map<string, { s: number; o: number; n: number; pages: number[] }>();
    for (const k of keys) {
      const nk = `${k.section}_${k.owner}_${k.note}`;
      if (!byNote.has(nk)) byNote.set(nk, { s: k.section, o: k.owner, n: k.note, pages: [] });
      byNote.get(nk)!.pages.push(k.page);
    }
    let deleted = 0;
    this.setStatus({ state: "scaricamento" });
    try {
      for (const g of byNote.values()) {
        const wStart = this.waitMsg(
          (t) => t === PenMessageType.OFFLINE_DATA_SEND_START || t === PenMessageType.OFFLINE_DATA_SEND_FAILURE,
          10000
        );
        // la penna cancella una pagina dopo averla mandata: i dati ricevuti si ignorano
        c.RequestOfflineData(g.s, g.o, g.n, true, g.pages);
        const first = await wStart;
        if (first.type === -1) throw new Error("penna disconnessa");
        if (first.type === PenMessageType.OFFLINE_DATA_SEND_START) {
          for (;;) {
            const r = await this.waitMsg((t) => t === PenMessageType.OFFLINE_DATA_SEND_STATUS || t === PenMessageType.OFFLINE_DATA_SEND_FAILURE, 15000);
            if (r.type < 0) throw new Error("la penna non ha completato la cancellazione");
            if (r.type === PenMessageType.OFFLINE_DATA_SEND_FAILURE || Number(r.args) >= 100) break;
          }
          await sleep(400);
        }
        deleted += g.pages.length;
      }
      return deleted;
    } finally {
      if (this.controller) this.setStatus({ state: "connesso" });
    }
  }

  private onOfflineStrokes(strokes: { Dots: any[] }[]): void {
    if (!this.collecting) return;
    for (const s of strokes) {
      const dots = s.Dots ?? [];
      if (!dots.length) continue;
      const first = dots[0];
      const stroke: Stroke = {
        t: first.timeStamp || 0,
        tip: first.penTipType ?? 0,
        color: first.color ?? 0,
        pts: [],
      };
      for (const d of dots) stroke.pts.push(d.x, d.y, d.f);
      stroke.pts = cleanPts(stroke.pts);
      const key = keyOf(first);
      if (!validKey(key) || stroke.pts.length < 3) continue;
      if (this.collectKey && !sameKey(key, this.collectKey)) continue;
      this.collecting.push(stroke);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      }
    );
  });
}
