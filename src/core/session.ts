import { PageKey, PenSettings, PenVersion, Stroke, keyLabel, mergeStrokes, pageId, sameKey } from "./models";
import { PenEvent, PenParser, PenRequest } from "./protocol";
import { PageStore } from "./store";

/** The channel to the pen (in the app: the native Bluetooth module; in tests: a simulated pen). */
export interface PenLink {
  send(bytes: Uint8Array): void;
}

export interface SessionOptions {
  /** Live strokes while writing (the pen then does not store them in its memory: the phone does). */
  live: boolean;
  /** After download the pen deletes the pages from its memory (later connections are faster). */
  deleteAfterDownload: boolean;
  /**
   * Experimental: if the pen declares the same strokes and bytes as last time, the page transfer is aborted.
   * (With the Bluefy prototype, after an abort the pen stopped answering: that's why it's off by default.)
   */
  skipUnchanged: boolean;
  /** Pen password, if it has one. */
  password: string;
}

export const defaultOptions = (): SessionOptions => ({ live: true, deleteAfterDownload: false, skipUnchanged: false, password: "" });

export class SessionError extends Error {
  constructor(readonly kind: "closed" | "timeout" | "passwordNeeded" | "wrongPassword", message: string) {
    super(message);
  }
}

const closedError = () => new SessionError("closed", "penna scollegata");
const timeoutError = (what: string) => new SessionError("timeout", `nessuna risposta (${what})`);

/** What happens during a connection (for the UI, the log and uploads). */
export type SessionNote =
  | { type: "authorized"; version: PenVersion; settings: PenSettings }
  | { type: "syncProgress"; done: number; total: number; key: PageKey | null }
  | { type: "pageUpdated"; key: PageKey; newStrokes: number }
  | { type: "syncFinished"; pages: number; newStrokes: number }
  | { type: "battery"; level: number }
  | { type: "powerOff" };

export type DownloadResult = { kind: "read"; count: number; newStrokes: number } | { kind: "unchanged" } | { kind: "empty" };

/** A page download from the pen's memory. */
interface Transfer {
  key: PageKey;
  started: boolean;
  failed: boolean;
  count: number;
  bytes: number;
  strokes: Stroke[];
  done: boolean;
  damaged: boolean;
  abort: boolean;
  lastActivity: number;
  /** Index of the last packet: it is acknowledged only after the strokes are saved on the phone. */
  lastIndex?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One connection with the pen: handshake, authorisation, clock, live mode and download of the memory.
 * Bytes from the pen come in through `receive`.
 */
export class PenSession {
  link: PenLink | null = null;
  log: (m: string) => void = () => {};
  note: (n: SessionNote) => void = () => {};

  version: PenVersion | null = null;
  settings: PenSettings | null = null;
  closed = false;

  private parser = new PenParser();
  private gotVersion: PenVersion | null = null;
  private gotSettings: PenSettings | null = null;
  private gotPassword: { ok: boolean; retry: number; reset: number } | null = null;
  private gotNotes: PageKey[] | null = null;
  private gotPages = new Map<string, number[]>();
  private gotOnline: boolean | null = null;
  private transfer: Transfer | null = null;

  constructor(readonly store: PageStore, public options: SessionOptions = defaultOptions()) {}

  // ---------------------------------------------------------------- bytes from the pen

  receive(bytes: ArrayLike<number>): void {
    for (const e of this.parser.feed(bytes)) this.handle(e);
  }

  /** The Bluetooth link closed. */
  linkClosed(): void {
    for (const e of this.parser.flushLive()) this.handle(e);
    this.closed = true;
  }

  private handle(e: PenEvent): void {
    switch (e.type) {
      case "version":
        this.gotVersion = e.version;
        break;
      case "settings":
        this.gotSettings = e.settings;
        this.settings = e.settings;
        break;
      case "passwordResult":
        this.gotPassword = e;
        break;
      case "onlineDataSet":
        this.gotOnline = e.ok;
        break;
      case "noteList":
        this.gotNotes = e.notes;
        break;
      case "pageList":
        this.gotPages.set(`${e.section}_${e.owner}_${e.note}`, e.pages);
        break;
      case "offlineStart": {
        const t = this.transfer;
        if (!t) return;
        t.started = true;
        t.count = e.strokes;
        t.bytes = e.bytes;
        t.lastActivity = Date.now();
        break;
      }
      case "offlineFailure":
        if (this.transfer) this.transfer.failed = true;
        break;
      case "offlineChunk": {
        const t = this.transfer;
        if (!t) {
          // unexpected packet: acknowledge anyway, so the pen doesn't get stuck
          if (!e.last) this.link?.send(PenRequest.offlineAck(e.index));
          return;
        }
        t.lastActivity = Date.now();
        if (e.damaged) t.damaged = true;
        for (const s of e.strokes) if (sameKey(s.key, t.key)) t.strokes.push(s.stroke);
        if (e.last) {
          // the last packet too gets its acknowledgement (like the official SDK): without it the pen does not close
          // the transfer and, with "empty the pen", does not delete the page. Sent once the strokes are saved.
          t.lastIndex = e.index;
          t.done = true;
        } else this.link?.send(PenRequest.offlineAck(e.index));
        break;
      }
      case "liveStroke": {
        const n = this.store.add([e.stroke], e.key);
        if (n > 0) this.note({ type: "pageUpdated", key: e.key, newStrokes: n });
        break;
      }
      case "lowBattery":
        this.log(`Batteria della penna bassa: ${e.level}%`);
        this.note({ type: "battery", level: e.level });
        break;
      case "powerOff":
        this.log("La penna si sta spegnendo.");
        this.note({ type: "powerOff" });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- waiting

  private send(b: Uint8Array): void {
    if (this.closed || !this.link) throw closedError();
    this.link.send(b);
  }

  /** Waits until `ready()` is true (checks every 50 ms). */
  private async wait(what: string, seconds: number, ready: () => boolean): Promise<void> {
    const end = Date.now() + seconds * 1000;
    while (!ready()) {
      if (this.closed) throw closedError();
      if (Date.now() > end) throw timeoutError(what);
      await sleep(50);
    }
  }

  // ---------------------------------------------------------------- connection

  /** Call as soon as the pen's Bluetooth notifications are on. */
  async start(): Promise<void> {
    await sleep(500); // like the official SDK: a freshly connected pen needs a moment
    let v: PenVersion | null = null;
    for (let attempt = 1; attempt <= 3 && !v; attempt++) {
      this.gotVersion = null;
      this.send(PenRequest.version());
      try {
        await this.wait("presentazione", 4, () => this.gotVersion !== null);
        v = this.gotVersion;
      } catch (e) {
        if (!(e instanceof SessionError) || e.kind !== "timeout") throw e;
        if (attempt === 3) throw timeoutError("la penna non si presenta");
        this.log("La penna non ha risposto alla presentazione, riprovo…");
      }
    }
    this.version = v;
    this.gotSettings = null;
    this.send(PenRequest.penStatus());
    await this.wait("impostazioni", 6, () => this.gotSettings !== null);
    const s = this.gotSettings!;
    if (s.locked) {
      if (!this.options.password) throw new SessionError("passwordNeeded", "la penna chiede una password: scrivila nelle impostazioni");
      this.gotPassword = null;
      this.send(PenRequest.password(this.options.password));
      await this.wait("password", 6, () => this.gotPassword !== null);
      const pw = this.gotPassword as { ok: boolean; retry: number; reset: number } | null;
      if (!pw?.ok) throw new SessionError("wrongPassword", `password sbagliata (${pw?.retry ?? 0}/${pw?.reset ?? 0} tentativi)`);
    }
    this.send(PenRequest.setTime(Date.now()));
    this.note({ type: "authorized", version: v!, settings: s });
    this.note({ type: "battery", level: s.battery });
    if (this.options.live) {
      this.gotOnline = null;
      this.send(PenRequest.onlineAllNotes());
      try {
        await this.wait("tempo reale", 4, () => this.gotOnline !== null);
      } catch (e) {
        if (!(e instanceof SessionError) || e.kind !== "timeout") throw e;
      }
      if (this.gotOnline === false) this.log("La penna non ha accettato il tempo reale: i tratti restano nella sua memoria.");
    }
  }

  // ---------------------------------------------------------------- pen memory

  /** Pages in the pen's memory. */
  async listMemory(): Promise<PageKey[]> {
    this.gotNotes = null;
    this.send(PenRequest.noteList());
    await this.wait("elenco dei quaderni", 10, () => this.gotNotes !== null);
    const notes = (this.gotNotes as PageKey[] | null) ?? [];
    const out: PageKey[] = [];
    for (const n of notes) {
      const id = `${n.section}_${n.owner}_${n.note}`;
      this.gotPages.delete(id);
      this.send(PenRequest.pageList(n.section, n.owner, n.note));
      await this.wait(`pagine del quaderno ${n.note}`, 10, () => this.gotPages.has(id));
      for (const page of this.gotPages.get(id) ?? []) out.push({ section: n.section, owner: n.owner, note: n.note, page });
    }
    return out.filter((k) => k.note > 0 && k.page >= 0);
  }

  /**
   * Downloads a page from the pen's memory and merges it into the phone's archive.
   * Empty reads are retried twice (after an interrupted connection the pen sometimes answers "can't").
   */
  async download(key: PageKey): Promise<DownloadResult> {
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        this.log(`Pagina ${keyLabel(key)}: la penna non l'ha mandata, riprovo (${attempt}/2)…`);
        await sleep(2500);
      }
      const t: Transfer = { key, started: false, failed: false, count: -1, bytes: -1, strokes: [], done: false, damaged: false, abort: false, lastActivity: Date.now() };
      this.transfer = t;
      try {
        this.send(PenRequest.offlineData(key.section, key.owner, key.note, [key.page], this.options.deleteAfterDownload));
        await this.wait(`inizio della pagina ${keyLabel(key)}`, 10, () => t.started || t.failed);
        if (t.failed) continue;
        // until the last packet; the timeout restarts at every packet
        while (!t.done && !t.failed) {
          if (this.closed) throw closedError();
          if (Date.now() - t.lastActivity > 15000) throw timeoutError(`la penna ha smesso di mandare la pagina ${keyLabel(key)}`);
          await sleep(50);
        }
        if (!t.strokes.length) {
          this.ackLast(t, false);
          continue;
        }
        const r = this.store.record(key);
        const added = mergeStrokes(r, t.strokes);
        if (!t.damaged) {
          r.penCount = t.count;
          r.penBytes = t.bytes;
        }
        this.store.save(r);
        // saved on the phone: now the pen may close the transfer (and delete the page if asked). A damaged page is
        // not confirmed, so the pen keeps it and sends it again next time.
        this.ackLast(t, !t.damaged);
        if (added > 0) this.note({ type: "pageUpdated", key, newStrokes: added });
        return { kind: "read", count: t.count, newStrokes: added };
      } finally {
        this.transfer = null;
      }
    }
    return { kind: "empty" };
  }

  private ackLast(t: Transfer, ok: boolean): void {
    if (t.lastIndex === undefined || this.closed) return;
    try {
      this.link?.send(PenRequest.offlineAck(t.lastIndex, ok, true));
    } catch {
      /* link closed: the pen keeps the page, it comes again next time */
    }
    t.lastIndex = undefined;
  }

  /**
   * Downloads the whole pen memory. Never-seen pages first, then from the last page down (the page being written
   * arrives first). Every page goes into the phone's archive at once: if the pen goes off midway, the next connection
   * starts again and also gets the missing pages.
   */
  async syncMemory(): Promise<{ pages: number; newStrokes: number }> {
    const keys = await this.listMemory();
    const ordered = [...keys].sort((a, b) => {
      const na = !this.store.pages.has(pageId(a));
      const nb = !this.store.pages.has(pageId(b));
      if (na !== nb) return na ? -1 : 1;
      if (a.note !== b.note) return b.note - a.note;
      return b.page - a.page;
    });
    this.log(`Nella memoria della penna: ${keys.length} pagine.`);
    let changed = 0;
    let fresh = 0;
    for (let i = 0; i < ordered.length; i++) {
      const key = ordered[i];
      this.note({ type: "syncProgress", done: i, total: ordered.length, key });
      const r = await this.download(key);
      if (r.kind === "read" && r.newStrokes > 0) {
        changed++;
        fresh += r.newStrokes;
        this.log(`Pagina ${keyLabel(key)}: ${r.newStrokes} tratti nuovi.`);
      } else if (r.kind === "read") this.log(`Pagina ${keyLabel(key)}: già scaricata.`);
      else if (r.kind === "unchanged") this.log(`Pagina ${keyLabel(key)}: invariata, saltata.`);
      else this.log(`Pagina ${keyLabel(key)}: lettura vuota, la riprovo al prossimo collegamento.`);
    }
    this.note({ type: "syncProgress", done: ordered.length, total: ordered.length, key: null });
    this.note({ type: "syncFinished", pages: changed, newStrokes: fresh });
    return { pages: changed, newStrokes: fresh };
  }
}
