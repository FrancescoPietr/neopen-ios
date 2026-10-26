// Il modulo "obsidian" per l'app del telefono: le parti dell'API di Obsidian che usa il motore del plugin
// (vault, file, proprietà, rinomina, requestUrl, moment…), fatte sui file del vault tramite VaultIO.
// Nell'app (e nei test) l'import "obsidian" del plugin punta qui; in Obsidian resta quello vero.
// Il comportamento imita quello di Obsidian: create() fallisce se il file c'è già, process() riscrive solo se cambia,
// renameFile() aggiorna i collegamenti [[…]] delle altre note, processFrontMatter() riscrive le proprietà in YAML.

import momentLib from "moment";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { HttpRequest, HttpResponse, VaultIO, VaultStat } from "./io";

export const moment = momentLib;
export const apiVersion = "1.8.0";

export const Platform = {
  isDesktop: false,
  isMobile: true,
  isDesktopApp: false,
  isMobileApp: true,
  isIosApp: true,
  isAndroidApp: false,
  isPhone: true,
  isTablet: false,
  isMacOS: false,
  isWin: false,
  isLinux: false,
  isSafari: true,
};

/** Come normalizePath di Obsidian. */
export function normalizePath(path: string): string {
  let p = String(path ?? "").replace(/[\\/]+/g, "/");
  p = p.replace(/^\/+|\/+$/g, "");
  if (p === "") p = "/";
  return p.replace(/ | /g, " ").normalize("NFC");
}

const hidden = (path: string) => path.split("/").some((s) => s.startsWith("."));
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// ---------------------------------------------------------------- collegamenti con l'app

/** Chi fa le richieste HTTP e dove vanno i messaggi (li imposta il motore). */
export const host: {
  request: (r: HttpRequest) => Promise<HttpResponse>;
  notify: (m: string) => void;
} = {
  request: async () => {
    throw new Error("requestUrl non disponibile");
  },
  notify: () => undefined,
};

export interface RequestUrlParam extends HttpRequest {
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: any;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export async function requestUrl(req: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const r: RequestUrlParam = typeof req === "string" ? { url: req } : req;
  const res = await host.request({ url: r.url, method: r.method ?? "GET", contentType: r.contentType, headers: r.headers, body: r.body });
  const out: RequestUrlResponse = {
    status: res.status,
    text: res.text,
    headers: {},
    get json() {
      return JSON.parse(res.text);
    },
    get arrayBuffer() {
      return new TextEncoder().encode(res.text).buffer as ArrayBuffer;
    },
  };
  if (r.throw !== false && res.status >= 400) throw new Error(`Request failed, status ${res.status}`);
  return out;
}

// ---------------------------------------------------------------- file e cartelle

export abstract class TAbstractFile {
  vault!: Vault;
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "/";
  }
}

function setPath(f: TAbstractFile, path: string): void {
  f.path = path;
  f.name = path === "/" ? "" : path.split("/").pop()!;
  if (f instanceof TFile) {
    const dot = f.name.lastIndexOf(".");
    f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
    f.extension = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : "";
  }
}

class Adapter {
  constructor(private vault: Vault, private io: VaultIO) {}

  getName(): string {
    return this.vault.getName();
  }
  async exists(path: string): Promise<boolean> {
    return this.io.stat(normalizePath(path)) !== null;
  }
  async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const s = this.io.stat(normalizePath(path));
    return s ? { type: s.folder ? "folder" : "file", ctime: s.ctime, mtime: s.mtime, size: s.size } : null;
  }
  async read(path: string): Promise<string> {
    const t = this.io.read(normalizePath(path));
    if (t === null) throw new Error(`ENOENT: no such file, open '${path}'`);
    return t;
  }
  async write(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    this.io.write(p, data);
    this.vault._touched(p);
  }
  async append(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    this.io.write(p, (this.io.read(p) ?? "") + data);
    this.vault._touched(p);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const b = this.io.readBinary(normalizePath(path));
    if (!b) throw new Error(`ENOENT: no such file, open '${path}'`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    this.io.writeBinary(p, new Uint8Array(data));
    this.vault._touched(p);
  }
  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    this.io.mkdir(p);
    this.vault._touched(p, true);
  }
  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    this.io.remove(p);
    this.vault._gone(p);
  }
  async rmdir(path: string): Promise<void> {
    return this.remove(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const a = normalizePath(from);
    const b = normalizePath(to);
    this.io.rename(a, b);
    this.vault._moved(a, b);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.io.list(normalizePath(path));
  }
  getResourcePath(): string {
    return "";
  }
}

export class Vault {
  readonly adapter: Adapter;
  readonly configDir = ".obsidian";
  private files = new Map<string, TAbstractFile>();
  private root = new TFolder();
  private cache = new Map<string, { mtime: number; text: string }>();

  constructor(private io: VaultIO, private name = "Vault") {
    this.adapter = new Adapter(this, io);
    this.root.vault = this;
    setPath(this.root, "/");
    this.files.set("/", this.root);
    for (const e of io.scan()) if (!hidden(e.path)) this.add(e.path, e.folder, e);
  }

  getName(): string {
    return this.name;
  }

  getRoot(): TFolder {
    return this.root;
  }

  private add(path: string, folder: boolean, stat?: VaultStat): TAbstractFile {
    const existing = this.files.get(path);
    if (existing) {
      if (existing instanceof TFile && stat) existing.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
      return existing;
    }
    const parentPath = parentOf(path);
    const parent = (parentPath ? this.add(parentPath, true) : this.root) as TFolder;
    const f = folder ? new TFolder() : new TFile();
    f.vault = this;
    setPath(f, path);
    f.parent = parent;
    parent.children.push(f);
    if (f instanceof TFile) {
      const now = Date.now();
      f.stat = stat ? { ctime: stat.ctime, mtime: stat.mtime, size: stat.size } : { ctime: now, mtime: now, size: 0 };
    }
    this.files.set(path, f);
    return f;
  }

  /** Un file scritto direttamente (adapter): entra nell'elenco come farebbe Obsidian. */
  _touched(path: string, folder = false): void {
    this.cache.delete(path);
    if (hidden(path)) return;
    const s = this.io.stat(path);
    const f = this.add(path, s ? s.folder : folder, s ?? undefined);
    if (f instanceof TFile && s) f.stat = { ctime: f.stat.ctime || s.ctime, mtime: s.mtime, size: s.size };
  }

  _gone(path: string): void {
    this.cache.delete(path);
    const f = this.files.get(path);
    if (!f) return;
    const drop = (x: TAbstractFile) => {
      if (x instanceof TFolder) for (const c of x.children) drop(c);
      this.files.delete(x.path);
      this.cache.delete(x.path);
    };
    drop(f);
    if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
  }

  _moved(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f) {
      this._touched(to);
      return;
    }
    if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
    const parent = (parentOf(to) ? this.add(parentOf(to), true) : this.root) as TFolder;
    const move = (x: TAbstractFile, path: string) => {
      this.files.delete(x.path);
      this.cache.delete(x.path);
      setPath(x, path);
      this.files.set(path, x);
      if (x instanceof TFolder) for (const c of x.children) move(c, `${path}/${c.name}`);
    };
    move(f, to);
    f.parent = parent;
    parent.children.push(f);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.files.values()];
  }

  getFiles(): TFile[] {
    return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  /** Testo del file (dalla memoria se non è cambiato sul disco). */
  _text(file: TFile): string {
    const s = this.io.stat(file.path);
    const hit = this.cache.get(file.path);
    if (hit && s && hit.mtime === s.mtime) return hit.text;
    const text = this.io.read(file.path);
    if (text === null) throw new Error(`ENOENT: no such file, open '${file.path}'`);
    if (s) this.cache.set(file.path, { mtime: s.mtime, text });
    return text;
  }

  async read(file: TFile): Promise<string> {
    this.cache.delete(file.path);
    return this._text(file);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this._text(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p) || this.io.stat(p)) throw new Error("File already exists.");
    this.io.write(p, data);
    this._touched(p);
    return this.files.get(p) as TFile;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p) || this.io.stat(p)) throw new Error("File already exists.");
    this.io.writeBinary(p, new Uint8Array(data));
    this._touched(p);
    return this.files.get(p) as TFile;
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.files.has(p) || this.io.stat(p)) throw new Error("Folder already exists.");
    this.io.mkdir(p);
    this._touched(p, true);
    return this.files.get(p) as TFolder;
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.io.write(file.path, data);
    this._touched(file.path);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.io.writeBinary(file.path, new Uint8Array(data));
    this._touched(file.path);
  }

  async append(file: TFile, data: string): Promise<void> {
    await this.modify(file, (await this.read(file)) + data);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const before = await this.read(file);
    const after = fn(before);
    if (after !== before) await this.modify(file, after);
    return after;
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const to = normalizePath(newPath);
    if (this.files.has(to) || this.io.stat(to)) throw new Error("Destination file already exists!");
    const from = file.path;
    this.io.rename(from, to);
    this._moved(from, to);
  }

  async delete(file: TAbstractFile): Promise<void> {
    this.io.remove(file.path);
    this._gone(file.path);
  }

  async trash(file: TAbstractFile): Promise<void> {
    return this.delete(file);
  }

  on(): { off: () => void } {
    return { off: () => undefined };
  }

  offref(): void {}

  getResourcePath(): string {
    return "";
  }
}

// ---------------------------------------------------------------- proprietà, blocchi, collegamenti

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface CachedMetadata {
  frontmatter?: Record<string, any>;
  frontmatterPosition?: { start: { line: number }; end: { line: number } };
  blocks?: Record<string, { id: string; position: { start: { line: number }; end: { line: number } } }>;
  tags?: { tag: string; position: { start: { line: number } } }[];
  headings?: { heading: string; level: number; position: { start: { line: number } } }[];
}

function metadata(text: string): CachedMetadata {
  const out: CachedMetadata = {};
  const m = FRONTMATTER.exec(text);
  let first = 0;
  if (m) {
    try {
      const fm = parseYaml(m[1] ?? "");
      if (fm && typeof fm === "object" && !Array.isArray(fm)) out.frontmatter = fm;
    } catch {
      /* proprietà non valide: come Obsidian, niente frontmatter */
    }
    const end = (m[0].match(/\n/g) ?? []).length - (m[0].endsWith("\n") ? 1 : 0);
    out.frontmatterPosition = { start: { line: 0 }, end: { line: end } };
    first = end + 1;
  }
  const lines = text.split("\n");
  let fence = false;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const b = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (b) (out.blocks ??= {})[b[1].toLowerCase()] = { id: b[1], position: { start: { line: i }, end: { line: i } } };
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) (out.headings ??= []).push({ heading: h[2].trim(), level: h[1].length, position: { start: { line: i } } });
    for (const t of line.matchAll(/(?:^|\s)(#[\p{L}\p{N}_\-/]+)/gu)) if (!/^#\d+$/.test(t[1])) (out.tags ??= []).push({ tag: t[1], position: { start: { line: i } } });
  }
  return out;
}

export class MetadataCache {
  constructor(private vault: Vault) {}
  getFileCache(file: TFile): CachedMetadata | null {
    if (file.extension !== "md") return null;
    try {
      return metadata(this.vault._text(file));
    } catch {
      return null;
    }
  }
  getCache(path: string): CachedMetadata | null {
    const f = this.vault.getFileByPath(path);
    return f ? this.getFileCache(f) : null;
  }
  getFirstLinkpathDest(linkpath: string): TFile | null {
    const want = normalizePath(linkpath.replace(/#.*$/, ""));
    const all = this.vault.getFiles();
    return (
      all.find((f) => f.path === want || f.path === `${want}.md`) ??
      all.find((f) => f.basename === want.split("/").pop() || f.name === want.split("/").pop()) ??
      null
    );
  }
  on(): { off: () => void } {
    return { off: () => undefined };
  }
}

/** Le proprietà riscritte come fa Obsidian (YAML a blocchi, liste con "  - "). */
export function writeFrontmatter(text: string, fm: Record<string, unknown>): string {
  const m = FRONTMATTER.exec(text);
  const rest = m ? text.slice(m[0].length) : text;
  const keys = Object.keys(fm).filter((k) => fm[k] !== undefined);
  if (!keys.length) return m ? rest : text;
  const yaml = stringifyYaml(Object.fromEntries(keys.map((k) => [k, fm[k]])), { lineWidth: 0 });
  return `---\n${yaml}---\n${rest}`;
}

export class FileManager {
  constructor(private vault: Vault, private cache: MetadataCache) {}

  async processFrontMatter(file: TFile, fn: (fm: any) => void): Promise<void> {
    await this.vault.process(file, (text) => {
      const m = FRONTMATTER.exec(text);
      let fm: Record<string, unknown> = {};
      if (m) {
        const parsed = parseYaml(m[1] ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed;
      }
      fn(fm);
      return writeFrontmatter(text, fm);
    });
  }

  /** Rinomina e aggiorna i collegamenti [[…]] nelle altre note (come Obsidian). */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const wasFile = file instanceof TFile;
    const oldBase = wasFile ? (file as TFile).basename : "";
    const oldNoExt = wasFile && (file as TFile).extension === "md" ? oldPath.replace(/\.md$/, "") : oldPath;
    // un nome breve ([[Nome]]) indica questo file solo se nessun altro file ha lo stesso nome
    const sameName = wasFile ? this.vault.getFiles().filter((f) => f !== file && f.basename === oldBase).length : 1;
    await this.vault.rename(file, newPath);
    if (!wasFile) return;
    const f = file as TFile;
    const newNoExt = f.extension === "md" ? f.path.replace(/\.md$/, "") : f.path;
    const newShort = this.vault.getFiles().filter((x) => x !== f && x.basename === f.basename).length ? newNoExt : f.extension === "md" ? f.basename : f.name;
    const oldShort = f.extension === "md" ? oldBase : oldPath.split("/").pop()!;
    const targets = new Set([oldNoExt, oldPath]);
    if (!sameName) targets.add(oldShort);
    const re = /(!?)\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
    for (const md of this.vault.getMarkdownFiles()) {
      const text = this.vault._text(md);
      if (!text.includes("[[")) continue;
      const out = text.replace(re, (all, bang: string, target: string, sub = "", alias = "") => {
        const t = target.trim();
        if (!targets.has(t)) return all;
        const full = t.includes("/") || t === oldPath;
        return `${bang}[[${full ? (t.endsWith(".md") ? f.path : newNoExt) : newShort}${sub}${alias}]]`;
      });
      if (out !== text) await this.vault.modify(md, out);
    }
  }

  generateMarkdownLink(file: TFile): string {
    return `[[${file.basename}]]`;
  }
}

// ---------------------------------------------------------------- l'app

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  workspace = {
    onLayoutReady: (cb: () => void) => cb(),
    on: () => ({ off: () => undefined }),
    getActiveFile: () => null,
    getLeaf: () => ({ openFile: async () => undefined, setViewState: async () => undefined }),
    getLeavesOfType: () => [],
    iterateAllLeaves: () => undefined,
    revealLeaf: () => undefined,
    activeLeaf: null,
  };
  /** Plugin del nucleo (note del giorno, modelli) con le loro impostazioni prese da .obsidian. */
  internalPlugins: { getPluginById: (id: string) => any };
  /** Plugin della comunità attivi (serve Templater: cartella dei template e comandi <% %>). */
  plugins: { plugins: Record<string, any>; getPlugin: (id: string) => any; enabledPlugins: Set<string> };

  constructor(io: VaultIO, vaultName: string, templater?: (content: string, file: TFile) => string) {
    this.vault = new Vault(io, vaultName);
    this.metadataCache = new MetadataCache(this.vault);
    this.fileManager = new FileManager(this.vault, this.metadataCache);
    const json = (path: string): any => {
      try {
        const t = io.read(path);
        return t ? JSON.parse(t) : null;
      } catch {
        return null;
      }
    };
    const core = json(".obsidian/core-plugins.json") ?? {};
    const coreOn = (id: string) => (Array.isArray(core) ? core.includes(id) : core[id] !== false);
    const options: Record<string, string> = { "daily-notes": ".obsidian/daily-notes.json", templates: ".obsidian/templates.json" };
    this.internalPlugins = {
      getPluginById: (id: string) =>
        options[id] ? { enabled: coreOn(id), instance: { options: coreOn(id) ? json(options[id]) ?? {} : {} } } : null,
    };
    const community: string[] = json(".obsidian/community-plugins.json") ?? [];
    const plugins: Record<string, any> = {};
    if (community.includes("templater-obsidian")) {
      const vault = this.vault;
      plugins["templater-obsidian"] = {
        settings: json(".obsidian/plugins/templater-obsidian/data.json") ?? {},
        templater: templater
          ? {
              overwrite_file_commands: async (file: TFile) => {
                await vault.process(file, (c) => templater(c, file));
              },
            }
          : undefined,
      };
    }
    this.plugins = { plugins, getPlugin: (id: string) => plugins[id] ?? null, enabledPlugins: new Set(Object.keys(plugins)) };
  }
}

// ---------------------------------------------------------------- interfaccia (sul telefono non si vede: niente)

export class Notice {
  noticeEl = {};
  constructor(message: string | unknown) {
    host.notify(typeof message === "string" ? message : String(message));
  }
  setMessage(): this {
    return this;
  }
  hide(): void {}
}

class Stub {
  constructor(..._args: unknown[]) {}
}

export class Component extends Stub {
  load(): void {}
  unload(): void {}
  addChild<T>(c: T): T {
    return c;
  }
  register(): void {}
  registerEvent(): void {}
  registerInterval(id: number): number {
    return id;
  }
  registerDomEvent(): void {}
}
export class Plugin extends Component {}
export class Modal extends Stub {
  open(): void {}
  close(): void {}
}
export class SuggestModal<T = unknown> extends Modal {
  _t?: T;
}
export class FuzzySuggestModal<T = unknown> extends Modal {
  _t?: T;
}
export class PluginSettingTab extends Stub {
  display(): void {}
  hide(): void {}
}
export class Setting extends Stub {
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  setClass(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addTextArea(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addExtraButton(): this {
    return this;
  }
  addSlider(): this {
    return this;
  }
}
export class ItemView extends Component {}
export class MarkdownRenderChild extends Component {}
export class MarkdownRenderer {
  static async render(): Promise<void> {}
}
export class Menu extends Stub {
  addItem(): this {
    return this;
  }
  showAtMouseEvent(): void {}
}
export class WorkspaceLeaf extends Stub {}
export function setIcon(): void {}
export function debounce<T extends (...a: any[]) => any>(fn: T, ms = 0): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...a: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}
export { parseYaml, stringifyYaml };
