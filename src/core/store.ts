import { PageKey, PageRecord, Stroke, mergeStrokes, needsUpload, newRecord, pageId } from "./models";

/** Where page files live (in the app: expo-file-system; in tests: memory or a temp folder). One JSON per page. */
export interface PageFiles {
  /** Ids of the saved pages. */
  list(): string[];
  read(id: string): string | null;
  write(id: string, text: string): void;
}

/** In-memory files (tests). */
export class MemoryFiles implements PageFiles {
  readonly files = new Map<string, string>();
  list() {
    return [...this.files.keys()];
  }
  read(id: string) {
    return this.files.get(id) ?? null;
  }
  write(id: string, text: string) {
    this.files.set(id, text);
  }
}

/**
 * Page archive on the phone. It is the safe copy of everything that comes from the pen, even before it reaches the
 * PC (and even when the pen is live and stores nothing itself).
 */
export class PageStore {
  readonly pages = new Map<string, PageRecord>();
  private listeners = new Set<() => void>();

  constructor(private files: PageFiles) {
    for (const id of files.list()) {
      try {
        const text = files.read(id);
        if (!text) continue;
        const r = JSON.parse(text) as PageRecord;
        if (r?.key && Array.isArray(r.strokes)) this.pages.set(pageId(r.key), r);
      } catch {
        /* unreadable file: skip it */
      }
    }
  }

  /** Called on every change (for the UI). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A copy of the page record (or a new empty one). */
  record(key: PageKey): PageRecord {
    const r = this.pages.get(pageId(key));
    return r ? { ...r, strokes: [...r.strokes] } : newRecord(key);
  }

  save(r: PageRecord): void {
    const id = pageId(r.key);
    this.pages.set(id, r);
    this.files.write(id, JSON.stringify(r));
    for (const fn of this.listeners) fn();
  }

  /** Adds strokes to a page and saves it. Returns how many were new. */
  add(strokes: Stroke[], key: PageKey): number {
    const r = this.record(key);
    const n = mergeStrokes(r, strokes);
    if (n > 0) this.save(r);
    return n;
  }

  get pendingUploads(): PageRecord[] {
    return [...this.pages.values()].filter(needsUpload).sort((a, b) => b.updated - a.updated);
  }

  /** "Resend all": every page goes to the PC again at the next upload. */
  markAllUnsent(): void {
    for (const r of [...this.pages.values()]) this.save({ ...r, sentCount: -1 });
  }
}
