// Il motore del plugin fatto girare dall'app del telefono (NeoTransfer), senza Obsidian aperto.
// Fa esattamente quello che fa il plugin in Obsidian sull'iPhone quando il PC è spento: prende le pagine con tratti
// nuovi, le trascrive con Claude e scrive le note nel vault con le stesse regole, template, cartelle e disegni.
// Usa le impostazioni del plugin (.obsidian/plugins/neo-pen/data.json) e ci salva lo stato (pagine trascritte, note),
// e il "turno" NeoPen/_turno.json: se un altro dispositivo sta trascrivendo, aspetta.

import { App, host } from "./obsidian";
import { canvasMaker } from "../render/png";
import { SoftCanvas } from "./canvas";
import type { HttpRequest, HttpResponse, VaultIO } from "./io";
import { DEFAULT_SETTINGS, NeoPenSettings } from "../settings";
import { PageStore } from "../store/PageStore";
import { NoteRouter } from "../notes/NoteRouter";
import { Transcriber } from "../transcribe/Transcriber";
import { PageKey, Stroke, pageId } from "../types";

export const SETTINGS_PATH = ".obsidian/plugins/neo-pen/data.json";
const LEASE_PATH = "NeoPen/_turno.json";
const LEASE_MS = 5 * 60_000;

export interface PhoneEngineOptions {
  io: VaultIO;
  vaultName: string;
  request: (r: HttpRequest) => Promise<HttpResponse>;
  /** Esegue i comandi di Templater (<% … %>) di un template appena messo in una nota. */
  templater?: (content: string, file: { basename: string; path: string }) => string;
  log: (m: string) => void;
  /** Chi trascrive, per il turno (diverso da quello di Obsidian). */
  deviceId: string;
}

export interface PhonePage {
  key: PageKey;
  strokes: Stroke[];
}

export type PhoneResult =
  | { status: "ok"; pages: string[] }
  | { status: "nothing" }
  | { status: "busy"; device: string }
  | { status: "no-settings" }
  | { status: "no-key" };

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  // niente <canvas> sul telefono: la tela fatta in JavaScript
  canvasMaker.create = (w, h) => new SoftCanvas(w, h) as unknown as HTMLCanvasElement;
  // il plugin ricava le date AAAA-MM-GG con toLocaleDateString("sv-SE"): se il motore JavaScript del telefono non
  // le scrive così, si fanno a mano (solo per "sv-SE")
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (new Date(2026, 0, 2).toLocaleDateString("sv-SE") !== "2026-01-02") {
    const date = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      if (locales === "sv-SE" && !options) return `${this.getFullYear()}-${p2(this.getMonth() + 1)}-${p2(this.getDate())}`;
      return date.call(this, locales, options);
    };
  }
  if (new Date(2026, 0, 2, 3, 4, 5).toLocaleString("sv-SE") !== "2026-01-02 03:04:05") {
    const both = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      if (locales === "sv-SE" && !options)
        return `${this.getFullYear()}-${p2(this.getMonth() + 1)}-${p2(this.getDate())} ${p2(this.getHours())}:${p2(this.getMinutes())}:${p2(this.getSeconds())}`;
      return both.call(this, locales, options);
    };
  }
}

/** Le impostazioni del plugin come le legge lui (valori di default per quello che manca), o null se non c'è. */
export function readSettings(io: VaultIO): NeoPenSettings | null {
  const text = io.read(SETTINGS_PATH);
  if (!text) return null;
  let data: Partial<NeoPenSettings>;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const s = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as NeoPenSettings, data);
  // v0.22: calendario e attività li fa l'app (come fa il plugin quando si aggiorna)
  if ((data.settingsVersion ?? 1) < 13) {
    s.calendarEnabled = false;
    s.settingsVersion = Math.max(13, s.settingsVersion);
  }
  return s;
}

const ink = (s: Stroke) => s.tip !== 1 && s.pts.length >= 3;

/** La pagina ha tratti non ancora trascritti (secondo lo stato salvato dal plugin)? */
export function pageNeedsWork(settings: NeoPenSettings, page: PhonePage): boolean {
  const e = settings.pageIndex?.[pageId(page.key)];
  const done = e?.done ?? 0;
  return page.strokes.some((s) => ink(s) && s.t > done);
}

/** Il turno: libero (o già nostro) → lo prende per 5 minuti. */
function takeLease(io: VaultIO, me: string): string {
  try {
    const cur = JSON.parse(io.read(LEASE_PATH) ?? "null");
    if (cur?.device && cur.device !== me && Number(cur.until) > Date.now()) return cur.device;
  } catch {
    /* illeggibile: si va avanti, come il plugin */
  }
  try {
    io.write(LEASE_PATH, JSON.stringify({ device: me, until: Date.now() + LEASE_MS }));
  } catch {
    /* come il plugin: si lavora comunque */
  }
  return "";
}

/**
 * Trascrive le pagine che hanno tratti nuovi e scrive le note. Le pagine sono quelle intere (tutti i tratti):
 * il plugin sa da solo quali tratti sono già nel testo.
 */
export async function transcribePages(opts: PhoneEngineOptions, pages: PhonePage[]): Promise<PhoneResult> {
  install();
  const { io, log } = opts;
  let settings = readSettings(io);
  if (!settings) return { status: "no-settings" };
  const todo = pages.filter((p) => pageNeedsWork(settings!, p));
  if (!todo.length) return { status: "nothing" };
  if (!settings.apiKey?.trim()) return { status: "no-key" };
  const other = takeLease(io, opts.deviceId);
  if (other) return { status: "busy", device: other };

  host.request = opts.request;
  host.notify = (m) => log(m.replace(/^Neo Pen:\s*/, ""));
  const app = new App(io, opts.vaultName, opts.templater);
  const save = async () => {
    io.write(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  };
  // come in main.ts del plugin
  let router!: NoteRouter;
  const store = new PageStore(
    app as never,
    () => settings!,
    log,
    () => undefined,
    async (page) => {
      const transcribing = !!settings!.apiKey && settings!.autoTranscribe;
      if (settings!.createNotes && !transcribing) await router.ensure(page.key, { created: page.created });
    },
    (id) => (router ? router.imageGroup(id) : [id]),
    () => settings!.pageIndex,
    save
  );
  router = new NoteRouter(app as never, () => settings!, save, (id) => store.svgPath(id), log, (rootId) => void store.writeGroup(rootId));
  const transcriber = new Transcriber(
    app as never,
    store,
    router,
    () => ({
      apiKey: settings!.apiKey,
      model: settings!.model,
      // dall'app la pagina si trascrive sempre (è il motivo per cui è stata mandata qui)
      auto: true,
      idleSeconds: settings!.idleSeconds,
      vocabulary: settings!.vocabulary,
      blacklist: settings!.blacklist ?? "",
      quality: settings!.quality,
      rootFolder: settings!.rootFolder,
      handwritingRefs: settings!.handwritingRefs ?? [],
      handwritingEnabled: settings!.handwritingEnabled,
      handwritingMax: settings!.handwritingMax,
      handwritingLang: settings!.handwritingLang,
      lineRows: (settings!.lineRows = settings!.lineRows ?? {}),
    }),
    log,
    (m) => log(m.replace(/^Neo Pen:\s*/, "")),
    (dollars) => {
      const month = new Date().toISOString().slice(0, 7);
      if (settings!.spendMonth !== month) {
        settings!.spendMonth = month;
        settings!.spendTotal = 0;
      }
      settings!.spendTotal += dollars;
      void save();
    },
    // copie di debug come nel plugin (Impostazioni → Neo Pen → copie di debug)
    () => (settings!.debugDump ? `${(settings!.rootFolder || "NeoPen").replace(/\/+$/, "")}/_debug` : ""),
    async (ids) => {
      settings!.handwritingRefs = ids;
      await save();
    }
  );
  if (settings.penMaxForce > 0) {
    store.setMaxForce(settings.penMaxForce);
    transcriber.setMaxForce(settings.penMaxForce);
  }

  // come quando le pagine arrivano dall'iPhone (pullRelay): la pagina intera, poi si trascrive quello che manca
  for (const p of todo) await store.setFromPen(p.key, p.strokes.length, p.strokes, undefined, "relay");
  transcriber.onOfflineDone();
  const t = transcriber as unknown as { running: boolean; queue: unknown[] };
  await new Promise<void>((resolve) => {
    const check = () => (!t.running && !t.queue.length ? resolve() : setTimeout(check, 200));
    setTimeout(check, 50);
  });
  await save();
  // il turno resta nostro ancora un po' (come il plugin): scade da solo
  return { status: "ok", pages: todo.map((p) => pageId(p.key)) };
}
