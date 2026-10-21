import { keyLabel } from "./models";
import { PageSender } from "./relay";
import { PageStore } from "./store";

/**
 * Sends changed pages to the PC (through the Google script), one at a time.
 * Pages not sent stay marked: they are retried on the next round (no network, slow script…).
 */
export class Uploader {
  client: PageSender | null = null;
  log: (m: string) => void = () => {};
  /** Called when something changes (to refresh the UI). */
  changed: () => void = () => {};
  /** Keeps the app alive in the background while uploading (in the app: a native background task). Returns "end". */
  keepAlive: (name: string) => () => void = () => () => {};

  busy = false;
  lastSuccess: Date | null = null;
  lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingEnd: (() => void) | null = null;
  private again = false;

  constructor(readonly store: PageStore) {}

  /** Uploads in `delay` seconds (close calls are merged: while writing, one upload every few seconds). */
  schedule(delay = 4): void {
    if (this.timer) clearTimeout(this.timer);
    // the wait is "background work" too: iOS doesn't suspend the app right before the upload
    if (!this.pendingEnd) this.pendingEnd = this.keepAlive("invio in attesa");
    this.timer = setTimeout(() => {
      this.timer = null;
      const end = this.pendingEnd;
      this.pendingEnd = null;
      void this.flush().finally(() => end?.());
    }, delay * 1000);
  }

  /** Cancels a scheduled upload (pending pages stay pending). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingEnd?.();
    this.pendingEnd = null;
  }

  /** Uploads all pending pages now. */
  async flush(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    const client = this.client;
    if (!client) {
      if (this.store.pendingUploads.length) this.lastError = "manca il collegamento allo script (impostazioni)";
      this.changed();
      return;
    }
    this.busy = true;
    this.changed();
    const end = this.keepAlive("invio pagine");
    try {
      do {
        this.again = false;
        for (const r of this.store.pendingUploads) {
          try {
            await client.put(r);
            const cur = this.store.record(r.key);
            // if more strokes arrived meanwhile, the page stays pending
            cur.sentCount = r.strokes.length;
            this.store.save(cur);
            this.lastSuccess = new Date();
            this.lastError = null;
            this.log(`Pagina ${keyLabel(r.key)} inviata al PC (${r.strokes.length} tratti).`);
          } catch (e) {
            this.lastError = e instanceof Error ? e.message : String(e);
            this.log(`Invio della pagina ${keyLabel(r.key)} non riuscito: ${this.lastError}. Riprovo più tardi.`);
            this.busy = false;
            this.schedule(60);
            return;
          }
          this.changed();
        }
      } while (this.again);
    } finally {
      this.busy = false;
      end();
      this.changed();
    }
  }
}
