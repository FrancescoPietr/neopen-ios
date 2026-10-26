// Collegamento diretto con Todoist (API ufficiale, con il tuo token personale:
// Todoist → Impostazioni → Integrazioni → Sviluppatore → Token API).

import { requestUrl } from "obsidian";

const BASES = ["https://api.todoist.com/api/v1", "https://api.todoist.com/rest/v2"];

export interface TodoistTask {
  content: string;
  description: string;
  /** YYYY-MM-DD, "" = nessuna scadenza. */
  date: string;
  done: boolean;
}

export class Todoist {
  private base = BASES[0];
  private projectCache = new Map<string, string>();

  constructor(private token: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    if (!this.token) throw new Error("manca il token di Todoist (Impostazioni → Neo Pen → Calendario e attività).");
    const send = (base: string) =>
      requestUrl({
        url: base + path,
        method,
        headers: { Authorization: `Bearer ${this.token}` },
        contentType: body ? "application/json" : undefined,
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });
    let res = await send(this.base);
    // versione dell'API non più disponibile: prova l'altra
    if ((res.status === 410 || (res.status === 404 && path === "/projects")) && this.base === BASES[0]) {
      const alt = await send(BASES[1]);
      if (alt.status < 400) {
        this.base = BASES[1];
        res = alt;
      }
    }
    if (res.status === 401 || res.status === 403) throw new Error("token di Todoist non valido.");
    let json: any = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** Verifica il token; restituisce i nomi dei progetti. */
  async projects(): Promise<{ id: string; name: string }[]> {
    const r = await this.call("GET", "/projects");
    if (r.status >= 400) throw new Error(`Todoist ha risposto ${r.status}.`);
    const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.results) ? r.json.results : [];
    return list.map((p: any) => ({ id: String(p.id), name: String(p.name) }));
  }

  /** id del progetto con questo nome ("" = Inbox). */
  async projectId(name: string): Promise<string> {
    if (!name) return "";
    if (this.projectCache.has(name)) return this.projectCache.get(name)!;
    const found = (await this.projects()).find((p) => p.name.toLowerCase() === name.toLowerCase());
    let id = found?.id ?? "";
    if (!id) {
      const r = await this.call("POST", "/projects", { name });
      if (r.status >= 400) throw new Error(`impossibile creare il progetto «${name}» in Todoist.`);
      id = String(r.json?.id ?? "");
    }
    this.projectCache.set(name, id);
    return id;
  }

  /** Crea o aggiorna un'attività; restituisce il suo id. */
  async upsert(id: string | undefined, t: TodoistTask, project: string): Promise<string> {
    const due = t.date ? { due_date: t.date } : { due_string: "no date" };
    if (id) {
      if (!t.done) await this.call("POST", `/tasks/${id}/reopen`); // se era completata
      const r = await this.call("POST", `/tasks/${id}`, { content: t.content, description: t.description, ...due });
      if (r.status < 400) {
        if (t.done) await this.call("POST", `/tasks/${id}/close`);
        return id;
      }
      if (r.status !== 404) throw new Error(`Todoist ha risposto ${r.status} aggiornando «${t.content}».`);
      // cancellata in Todoist: la ricreiamo
    }
    const projectId = await this.projectId(project);
    const r = await this.call("POST", "/tasks", {
      content: t.content,
      description: t.description,
      ...(t.date ? { due_date: t.date } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    });
    if (r.status >= 400 || !r.json?.id) throw new Error(`Todoist ha risposto ${r.status} creando «${t.content}».`);
    const newId = String(r.json.id);
    if (t.done) await this.call("POST", `/tasks/${newId}/close`);
    return newId;
  }

  async remove(id: string): Promise<void> {
    const r = await this.call("DELETE", `/tasks/${id}`);
    if (r.status >= 400 && r.status !== 404) throw new Error(`Todoist ha risposto ${r.status} cancellando un'attività.`);
  }
}
