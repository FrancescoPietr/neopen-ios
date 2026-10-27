// Pagine → note di Obsidian, sul telefono: anche con Obsidian chiuso, il PC spento e il telefono bloccato.
// Fa girare il motore del plugin Neo Pen (cartella plugin/, lo stesso codice che gira in Obsidian) sulla cartella del
// vault: stesse impostazioni del plugin (regole dei #tag, template, cartella del taccuino, vocabolario…), stesso stato
// delle pagine (chi trascrive dopo, app o Obsidian, sa cosa è già fatto) e stesso "turno" per non lavorare in due.
// Un solo trascrittore: lo dice allo script Google (pseudo-pagina "telefono") e Obsidian, sul PC o sull'iPhone, non
// rifà le pagine: le note gli arrivano già fatte con la sincronizzazione.
// Parte quando smetti di scrivere (penna spenta o 2 minuti senza tratti), dopo che le attività e gli appuntamenti della
// pagina sono stati sistemati (così le righe messe dal telefono vengono prese dalla trascrizione, senza doppioni).
import { Directory, File, Paths } from "expo-file-system";
import NeoPenBle from "../../modules/neopen-ble";
import type { HttpRequest, HttpResponse, VaultEntry, VaultIO, VaultStat } from "../../plugin/src/phone/io";
import { fromBase64, toBase64 } from "../core/bytes";
import { PageKey, Stroke } from "../core/models";
import { fillTemplate } from "../core/penInbox";
import { PageStore } from "../core/store";
import { agenda } from "./agenda";
import { alerts } from "./alerts";
import { refreshOutputs } from "./outputs";

interface EnginePage {
  key: PageKey;
  strokes: Stroke[];
}

type EngineResult =
  | { status: "ok"; pages: string[] }
  | { status: "nothing" }
  | { status: "busy"; device: string }
  | { status: "no-settings" }
  | { status: "no-key" };

/** Il motore del plugin (plugin/src/phone/engine.ts). Lo controllano i tipi del plugin, non quelli dell'app. */
interface EngineModule {
  readSettings(io: VaultIO): { apiKey?: string; pageIndex?: Record<string, { done?: number }> } | null;
  pageNeedsWork(settings: object, page: EnginePage): boolean;
  transcribePages(
    opts: {
      io: VaultIO;
      vaultName: string;
      deviceId: string;
      log: (m: string) => void;
      request: (r: HttpRequest) => Promise<HttpResponse>;
      templater?: (content: string, file: { basename: string; path: string }) => string;
    },
    pages: EnginePage[]
  ): Promise<EngineResult>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engine: EngineModule = require("../../plugin/src/phone/engine");

/** Il vault per il motore: la cartella scelta nell'app (funzioni native, sincrone). */
class NativeVaultIO implements VaultIO {
  private static check(error: string): void {
    if (error) throw new Error(error);
  }
  scan(): VaultEntry[] {
    return NeoPenBle.vaultScan();
  }
  stat(path: string): VaultStat | null {
    return NeoPenBle.vaultStat(path) ?? null;
  }
  read(path: string): string | null {
    return NeoPenBle.vaultReadText(path) ?? null;
  }
  write(path: string, text: string): void {
    NativeVaultIO.check(NeoPenBle.writeVaultFile(path, text));
  }
  readBinary(path: string): Uint8Array | null {
    const b = NeoPenBle.vaultReadBase64(path);
    return b == null ? null : fromBase64(b);
  }
  writeBinary(path: string, data: Uint8Array): void {
    NativeVaultIO.check(NeoPenBle.vaultWriteBase64(path, toBase64(data)));
  }
  mkdir(path: string): void {
    NativeVaultIO.check(NeoPenBle.vaultMkdir(path));
  }
  remove(path: string): void {
    NativeVaultIO.check(NeoPenBle.vaultRemove(path));
  }
  rename(from: string, to: string): void {
    NativeVaultIO.check(NeoPenBle.vaultRename(from, to));
  }
  list(dir: string): { files: string[]; folders: string[] } {
    return NeoPenBle.vaultList(dir);
  }
}

const plain = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let counter = 0;

/**
 * Richiesta che va avanti anche col telefono bloccato (la stessa via delle altre richieste a Claude dell'app):
 * se iOS sospende l'app, la risposta arriva lo stesso e il lavoro riprende quando iOS la risveglia.
 */
export async function backgroundRequest(req: HttpRequest): Promise<HttpResponse> {
  const dir = new Directory(Paths.document, "http");
  dir.create({ intermediates: true, idempotent: true });
  const id = `nota-${Date.now()}-${++counter}`;
  const body = new File(dir, `${id}.req`);
  body.create({ overwrite: true });
  body.writeSync(req.body ?? "");
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = req.contentType;
  if (!NeoPenBle.startBackgroundPost(id, req.url, headers, plain(body.uri))) {
    body.delete();
    throw new Error(`indirizzo non valido: ${req.url}`);
  }
  const done = new File(dir, `${id}.done`);
  const answer = new File(dir, `${id}.body`);
  const started = Date.now();
  while (!done.exists) {
    if (Date.now() - started > 20 * 60_000) throw new Error("nessuna risposta");
    await sleep(500);
  }
  try {
    const info = JSON.parse(done.textSync()) as { status: number; error?: string };
    const text = answer.exists ? answer.textSync() : "";
    if (info.error && !info.status) throw new Error(info.error);
    return { status: info.status, text };
  } finally {
    for (const f of [body, done, answer]) {
      try {
        if (f.exists) f.delete();
      } catch {
        /* resti innocui */
      }
    }
  }
}

export interface PageNotesConfig {
  enabled: boolean;
  /** Lo script Google (per dire a Obsidian che trascrive il telefono), se configurato. */
  relay: { url: string; secret: string } | null;
}

export class PageNotes {
  private wanted = false;
  private running = false;
  private notBefore = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private told = new Set<string>();

  constructor(
    private store: PageStore,
    private config: () => PageNotesConfig,
    /** Le attività e gli appuntamenti della pagina sono ancora in lavorazione? Allora si aspetta. */
    private phoneBusy: () => boolean,
    private log: (m: string) => void
  ) {}

  private tellOnce(key: string, m: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.log(m);
  }

  /** Tratti nuovi: se smetti di scrivere per 2 minuti, si trascrive. */
  strokesArrived(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.request(), 120_000);
  }

  /** Penna spenta (o app aperta): da trascrivere appena possibile. */
  request(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.config().enabled) return;
    this.wanted = true;
    this.tick();
  }

  /** Chiamata spesso (e quando arriva una risposta): parte se c'è da fare e nient'altro è in corso. */
  tick(): void {
    if (!this.wanted || this.running || !this.config().enabled) return;
    if (Date.now() < this.notBefore || this.phoneBusy()) return;
    this.wanted = false;
    this.running = true;
    const task = NeoPenBle.beginBackgroundTask("note-obsidian");
    void this.run()
      .catch((e) => this.log(`Note di Obsidian: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = false;
        NeoPenBle.endBackgroundTask(task);
      });
  }

  private handlesAt = 0;
  private handlesValue = false;

  /**
   * The notes of the pages are written here (interruttore acceso, cartella del vault scelta, plugin con la chiave di
   * Claude)? Then everything comes from the notes, as with the plugin: the quick reading of the pages (phoneEvents)
   * stops, so nothing is written twice (an appointment also among the tasks, the same task twice).
   */
  handles(): boolean {
    if (!this.config().enabled) return false;
    if (Date.now() - this.handlesAt < 60_000) return this.handlesValue;
    this.handlesAt = Date.now();
    try {
      const settings = NeoPenBle.vaultFolderName() ? engine.readSettings(new NativeVaultIO()) : null;
      this.handlesValue = !!settings?.apiKey?.trim();
    } catch {
      this.handlesValue = false;
    }
    return this.handlesValue;
  }

  private beatAt = 0;
  private beatValue = -1;

  /**
   * Dice allo script Google che le pagine le trascrive il telefono (pseudo-pagina "telefono", count = adesso; 0 se
   * l'interruttore è spento): Obsidian sul PC o sull'iPhone allora non le rifà (un solo trascrittore, niente doppioni).
   */
  async heartbeat(force = false): Promise<void> {
    const relay = this.config().relay;
    if (!relay) return;
    const on = this.config().enabled;
    if (!force && on && this.beatValue > 0 && Date.now() - this.beatAt < 6 * 3_600_000) return;
    if (!force && !on && this.beatValue === 0) return;
    const count = on ? Date.now() : 0;
    try {
      const res = await backgroundRequest({
        url: relay.url,
        method: "POST",
        contentType: "text/plain;charset=utf-8",
        body: JSON.stringify({ secret: relay.secret, relay: { action: "put", pages: [{ id: "telefono", count, strokes: [] }] } }),
      });
      if (res.status >= 200 && res.status < 300) {
        this.beatAt = Date.now();
        this.beatValue = count;
      }
    } catch {
      /* si riprova alla prossima */
    }
  }

  private async run(): Promise<void> {
    const vault = NeoPenBle.vaultFolderName();
    if (!vault) {
      this.tellOnce("vault", "Note di Obsidian: scegli la cartella del vault (Penna → Impostazioni) e le scrivo.");
      return;
    }
    const io = new NativeVaultIO();
    const settings = engine.readSettings(io);
    if (!settings) {
      this.tellOnce("settings", "Note di Obsidian: nel vault non trovo le impostazioni del plugin Neo Pen (.obsidian/plugins/neo-pen).");
      return;
    }
    if (!settings.apiKey?.trim()) {
      this.tellOnce("key", "Note di Obsidian: nel plugin Neo Pen manca la chiave di Claude.");
      return;
    }
    // da qui le pagine le trascrive solo il telefono: Obsidian (PC o iPhone) lo legge nello script e non le rifà
    await this.heartbeat();
    const pages: EnginePage[] = [...this.store.pages.values()].map((r) => ({ key: r.key, strokes: r.strokes }));
    if (!pages.some((p) => engine.pageNeedsWork(settings, p))) return;
    // the notes as they are now: afterwards the calendar follows what the transcription changed (agenda.followPen)
    await agenda.freshTasks();
    let noCredit = false;
    const r = await engine.transcribePages(
      {
        io,
        vaultName: vault,
        deviceId: "app-telefono",
        log: (m) => {
          if (/credit balance is too low/i.test(m)) noCredit = true;
          this.log(m);
        },
        request: backgroundRequest,
        templater: (content, file) => fillTemplate(content, /^\d{4}-\d{2}-\d{2}$/.test(file.basename) ? file.basename : new Date().toLocaleDateString("sv-SE"), file.basename),
      },
      pages
    );
    // credito di Claude finito: lo dice subito con una notifica e riprova da solo ogni 10 minuti (appena ricarichi
    // le pagine si trascrivono senza dover riscrivere niente con la penna)
    if (noCredit) {
      void alerts.now("credito-claude", "Claude: credito finito", "Le pagine scritte con la penna aspettano: ricarica il credito di Claude e le trascrivo da solo.");
      this.log("Credito di Claude finito: riprovo tra 10 minuti.");
      this.wanted = true;
      this.notBefore = Date.now() + 10 * 60_000;
      return;
    }
    if (r.status === "busy") {
      this.log("Note di Obsidian: un altro dispositivo sta trascrivendo, riprovo tra qualche minuto.");
      this.wanted = true;
      this.notBefore = Date.now() + 3 * 60_000;
      return;
    }
    if (r.status === "ok") {
      this.log(`Note di Obsidian aggiornate (${r.pages.length === 1 ? "1 pagina" : `${r.pages.length} pagine`}).`);
      // read again: an appointment struck through or changed on the paper is changed in the calendar too
      await agenda.freshTasks();
      agenda.changedOutside();
      refreshOutputs(500);
    }
  }
}
