// Appointments straight from the phone: when you stop writing (pen off, or a couple of minutes without strokes) the
// new strokes of each page are drawn, sent to Claude (tasks with a time only) and the events go to the calendar
// through the Google script. Every request is a native background request, so it all works with the phone locked.
// The Obsidian plugin later replaces these events with its own (no duplicates: the script keeps the list per page).
import { Directory, File, Paths } from "expo-file-system";
import NeoPenBle from "../../modules/neopen-ble";
import { eventsRequest, parseTasks, strokesAfter } from "../core/events";
import { keyLabel, PageKey, pageId } from "../core/models";
import { renderNewStrokesPng } from "../core/render";
import { PageStore } from "../core/store";
import { toBase64 } from "../core/bytes";
import { readJson, writeJson } from "./files";

interface State {
  /** The starting point is set (strokes written before the feature was turned on are never sent). */
  base: boolean;
  /** Per page: pen-down time of the last stroke already handled. */
  upTo: Record<string, number>;
  /** Claude requests in flight: request id → page and strokes it covers. */
  reading: Record<string, { page: string; upTo: number; writtenAt: number }>;
  /** Calendar requests in flight. */
  saving: Record<string, { page: string; upTo: number; n: number }>;
  /** Failed attempts per page (to stop after a few). */
  fails: Record<string, number>;
}

const EMPTY: State = { base: false, upTo: {}, reading: {}, saving: {}, fails: {} };
const FILE = "telefono-eventi.json";
const plain = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

export interface PhoneEventsConfig {
  enabled: boolean;
  apiKey: string;
  scriptURL: string;
  secret: string;
}

export class PhoneEvents {
  private state: State = { ...EMPTY, ...readJson<State>(FILE, EMPTY) };
  private idle: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;

  constructor(
    private store: PageStore,
    private config: () => PhoneEventsConfig,
    private log: (m: string) => void
  ) {}

  private save(): void {
    writeJson(FILE, this.state);
  }

  private dir(): Directory {
    const d = new Directory(Paths.document, "http");
    d.create({ intermediates: true, idempotent: true });
    return d;
  }

  /** New strokes arrived: if you stop writing for 2 minutes, the page is read. */
  strokesArrived(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kick(), 120_000);
  }

  /** The pen went off (or you stopped writing): read the pages with new strokes. */
  kick(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const c = this.config();
    if (!c.enabled || !c.apiKey.trim() || !c.scriptURL || !c.secret) return;
    if (!this.state.base) {
      // first time: what is already on the pages is not news
      for (const r of this.store.pages.values()) this.state.upTo[pageId(r.key)] = Math.max(0, ...r.strokes.map((s) => s.t));
      this.state.base = true;
      this.save();
      this.log("Eventi dal telefono attivi: da ora le attività con orario che scrivi vanno subito nel calendario.");
      return;
    }
    const busy = new Set([...Object.values(this.state.reading), ...Object.values(this.state.saving)].map((r) => r.page));
    for (const r of this.store.pages.values()) {
      const id = pageId(r.key);
      if (busy.has(id) || (this.state.fails[id] ?? 0) >= 3) continue;
      const fresh = strokesAfter(r, this.state.upTo[id] ?? 0);
      if (!fresh.length) continue;
      const mark = this.state.upTo[id] ?? 0;
      // the page with the strokes already handled in gray: a time added to an old task is read together with it
      const png = renderNewStrokesPng(r.strokes, (st) => st.t > mark);
      if (!png) continue;
      const upTo = Math.max(...fresh.map((s) => s.t));
      const writtenAt = Math.min(...fresh.map((s) => s.t).filter((t) => t > 1_000_000_000_000), Date.now());
      const req = `ev-${Date.now()}-${++this.counter}`;
      const f = new File(this.dir(), `${req}.req`);
      f.create({ overwrite: true });
      f.writeSync(eventsRequest(toBase64(png.bytes), png, writtenAt));
      const ok = NeoPenBle.startBackgroundPost(
        req,
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": c.apiKey.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        plain(f.uri)
      );
      if (!ok) continue;
      this.state.reading[req] = { page: id, upTo, writtenAt };
      this.save();
      this.log(`${keyLabel(r.key)}: cerco attività in ${fresh.length} tratti nuovi…`);
    }
  }

  /** Reads the answers that arrived (also those that arrived while the app was asleep). Call often. */
  poll(): void {
    const dir = this.dir();
    const c = this.config();
    for (const [req, info] of Object.entries(this.state.reading)) {
      const done = new File(dir, `${req}.done`);
      if (!done.exists) continue;
      const result = this.take(req);
      delete this.state.reading[req];
      const label = keyLabel(keyOf(info.page));
      if (!result.ok) {
        this.state.fails[info.page] = (this.state.fails[info.page] ?? 0) + 1;
        this.log(`${label}: lettura non riuscita (${result.error}). ${this.state.fails[info.page] >= 3 ? "Lascio fare al PC." : "Riprovo alla prossima."}`);
        this.save();
        continue;
      }
      let found: ReturnType<typeof parseTasks> | null;
      try {
        found = parseTasks(result.body, info.writtenAt);
      } catch {
        found = null;
      }
      if (!found) {
        this.state.fails[info.page] = (this.state.fails[info.page] ?? 0) + 1;
        this.log(`${label}: risposta di Claude non leggibile.`);
      } else if (!found.events.length && !found.todos.length) {
        this.state.upTo[info.page] = Math.max(this.state.upTo[info.page] ?? 0, info.upTo);
        delete this.state.fails[info.page];
        this.log(`${label}: nessuna attività nei tratti nuovi.`);
      } else {
        const { events, todos } = found;
        const id = `cal-${Date.now()}-${++this.counter}`;
        const f = new File(dir, `${id}.req`);
        f.create({ overwrite: true });
        f.writeSync(JSON.stringify({ secret: c.secret, phone: { action: "add", page: info.page, upTo: info.upTo, events, todos } }));
        if (NeoPenBle.startBackgroundPost(id, c.scriptURL, { "Content-Type": "text/plain;charset=utf-8" }, plain(f.uri))) {
          this.state.saving[id] = { page: info.page, upTo: info.upTo, n: events.length + todos.length };
          const when = (iso: string) => new Date(iso).toLocaleString("it-IT", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          const parts = [
            ...events.map((e) => `«${e.title}» ${when(e.start)} → calendario`),
            ...todos.map((t) => `«${t.title}»${t.date ? ` (${t.date})` : ""} → attività`),
          ];
          this.log(`${label}: ${parts.join(", ")}…`);
        }
      }
      this.save();
    }
    for (const [req, info] of Object.entries(this.state.saving)) {
      if (!new File(dir, `${req}.done`).exists) continue;
      const result = this.take(req);
      delete this.state.saving[req];
      // even on error the strokes count as handled: better a missing event (the PC adds it) than a duplicate
      this.state.upTo[info.page] = Math.max(this.state.upTo[info.page] ?? 0, info.upTo);
      delete this.state.fails[info.page];
      let answer: { ok?: boolean; created?: number; todos?: number; todoError?: string; error?: string; results?: unknown } = {};
      try {
        answer = JSON.parse(result.body);
      } catch {
        /* checked below */
      }
      const label = keyLabel(keyOf(info.page));
      if (result.ok && answer.ok && typeof answer.created === "number") {
        const bits = [
          answer.created ? `${answer.created} ${answer.created === 1 ? "evento creato" : "eventi creati"} nel calendario` : "",
          answer.todos ? `${answer.todos} ${answer.todos === 1 ? "attività creata" : "attività create"}` : "",
        ].filter(Boolean);
        this.log(`${label}: ${bits.join(", ") || "niente da creare"}.${answer.todoError ? ` Attività: ${answer.todoError}` : ""}`);
      }
      else if (answer.results !== undefined) this.log(`${label}: lo script Google è una versione vecchia. In Obsidian sul PC: Impostazioni → Neo Pen → copia di nuovo lo script e ripubblicalo.`);
      else this.log(`${label}: calendario non aggiornato (${answer.error ?? result.error ?? "risposta non valida"}). Lo farà il PC.`);
      this.save();
    }
  }

  /** Answer of a finished request; its files are removed. */
  private take(req: string): { ok: boolean; body: string; error?: string } {
    const dir = this.dir();
    const files = ["req", "done", "body"].map((ext) => new File(dir, `${req}.${ext}`));
    let info: { status?: number; error?: string } = {};
    let body = "";
    try {
      info = JSON.parse(files[1].textSync());
      body = files[2].exists ? files[2].textSync() : "";
    } catch {
      /* unreadable: treated as an error */
    }
    for (const f of files) {
      try {
        if (f.exists) f.delete();
      } catch {
        /* leftovers are harmless */
      }
    }
    if (info.error) return { ok: false, body, error: info.error };
    const status = info.status ?? 0;
    if (status < 200 || status >= 300) {
      let msg = `stato ${status}`;
      try {
        msg = JSON.parse(body)?.error?.message ?? msg;
      } catch {
        /* keep the status */
      }
      return { ok: false, body, error: status === 401 ? "chiave di Claude non valida" : msg };
    }
    return { ok: true, body };
  }
}

function keyOf(id: string): PageKey {
  const [section, owner, note, page] = id.split("_").map(Number);
  return { section, owner, note, page };
}
