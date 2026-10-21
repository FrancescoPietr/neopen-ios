import { PageRecord, pageId, rounded } from "./models";

/** Who receives pages (the Google script; a fake one in tests). */
export interface PageSender {
  put(r: PageRecord): Promise<void>;
}

export class RelayError extends Error {}

/**
 * Upload to the Google Apps Script (the same one the Bluefy page used): the Obsidian plugin on the PC picks pages
 * up from there and transcribes them. Format: `{secret, relay: {action: "put", pages: [{id, count, strokes}]}}`.
 */
export class RelayClient implements PageSender {
  constructor(readonly url: string, readonly secret: string, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  /** Do URL and secret look right? */
  static looksValid(url: string, secret: string): boolean {
    return url.startsWith("https://script.google.com/") && url.endsWith("/exec") && secret.length > 8;
  }

  /** The exact request body (also used by tests). */
  putBody(r: PageRecord): string {
    const page = { id: pageId(r.key), count: r.strokes.length, strokes: r.strokes.map(rounded) };
    return JSON.stringify({ secret: this.secret, relay: { action: "put", pages: [page] } });
  }

  put(r: PageRecord): Promise<void> {
    return this.post(this.putBody(r));
  }

  ping(): Promise<void> {
    return this.post(JSON.stringify({ secret: this.secret, relay: { action: "ping" } }));
  }

  private async post(body: string): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      // text/plain: no CORS preflight, like the Bluefy page
      const res = await this.fetchImpl(this.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, signal: ctrl.signal });
      if (!res.ok) throw new RelayError(`lo script ha risposto ${res.status}`);
      RelayClient.check(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Checks the script's answer: `{ok: true}` or a readable error. */
  static check(text: string): void {
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new RelayError(
        /<html|<!DOCTYPE/i.test(text)
          ? "lo script ha risposto con una pagina web: controlla che sia pubblicato per «Chiunque»"
          : "risposta non valida dallo script"
      );
    }
    if (obj?.ok === true) return;
    if (obj?.results !== undefined) throw new RelayError("lo script è una versione vecchia: ricopialo dal plugin");
    const err = String(obj?.error ?? "errore dello script");
    throw new RelayError(err === "secret" ? "la chiave segreta non corrisponde" : err);
  }
}
