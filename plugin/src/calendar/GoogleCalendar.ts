// Collegamento con Google Calendar tramite un piccolo Google Apps Script tuo
// (lo incolli una volta in script.google.com e lo pubblichi come "app web").
// Niente progetti Google Cloud né accessi che scadono: lo script gira col tuo account
// e accetta solo richieste con la tua chiave segreta.

import { requestUrl } from "obsidian";

export interface CalendarOp {
  action: "upsert" | "delete" | "ping";
  /** Evento del calendario (predefinito) o attività di Google Tasks. */
  kind?: "event" | "task";
  /** Lista di Google Tasks (nome; vuoto = quella predefinita). */
  list?: string;
  /** Chiave stabile del task (per non creare doppioni anche se una risposta va persa). */
  key?: string;
  /** id dell'evento già creato, se c'è. */
  id?: string;
  title?: string;
  description?: string;
  allDay?: boolean;
  /** Giorno YYYY-MM-DD (eventi di un giorno intero, e ricerca per chiave). */
  date?: string;
  /** Inizio e fine ISO con fuso orario (eventi con orario). */
  start?: string;
  end?: string;
  /** Inizio e fine "da orologio" (YYYY-MM-DD HH:mm), nel fuso del calendario. */
  startLocal?: string;
  endLocal?: string;
  done?: boolean;
}

export interface CalendarResult {
  ok: boolean;
  id?: string;
  calendar?: string;
  /** Il servizio Google Tasks è attivo nello script. */
  tasks?: boolean;
  error?: string;
}

export async function callCalendar(url: string, secret: string, calendarId: string, ops: CalendarOp[]): Promise<CalendarResult[]> {
  if (!url) throw new Error("manca l'indirizzo dello script del calendario (Impostazioni → Neo Pen → Calendario).");
  const res = await requestUrl({
    url,
    method: "POST",
    // text/plain: Apps Script legge il corpo così com'è
    contentType: "text/plain;charset=utf-8",
    body: JSON.stringify({ secret, calendarId, ops }),
    throw: false,
  });
  let data: any;
  try {
    data = typeof res.json === "object" ? res.json : JSON.parse(res.text);
  } catch {
    const hint = /<html/i.test(res.text ?? "")
      ? " Lo script ha risposto con una pagina web: controlla che sia pubblicato come app web con accesso «Chiunque»."
      : "";
    throw new Error(`risposta non valida dal calendario (HTTP ${res.status}).${hint}`);
  }
  if (!data?.ok) {
    const err = String(data?.error ?? "errore sconosciuto");
    if (err === "secret") throw new Error("la chiave segreta non corrisponde: ricopia lo script dalle impostazioni e ripubblicalo.");
    if (err === "calendar") throw new Error("calendario non trovato: controlla l'id del calendario nelle impostazioni.");
    throw new Error(err);
  }
  return Array.isArray(data.results) ? data.results : [];
}

export interface RelayPage {
  id: string;
  count: number;
  updated?: number;
  strokes?: any[];
}

/** Pagine lasciate dall'iPhone nello script (cartella «NeoPen-iPhone» su Drive). */
export async function callRelay(url: string, secret: string, relay: Record<string, unknown>): Promise<any> {
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "text/plain;charset=utf-8",
    body: JSON.stringify({ secret, relay }),
    throw: false,
  });
  let data: any;
  try {
    data = typeof res.json === "object" ? res.json : JSON.parse(res.text);
  } catch {
    throw new Error(`risposta non valida dallo script (HTTP ${res.status})`);
  }
  if (!data?.ok) {
    const err = String(data?.error ?? "errore sconosciuto");
    if (err === "secret") throw new Error("la chiave segreta non corrisponde");
    if (/DriveApp|Drive/i.test(err) && /permission|autoriz|access/i.test(err)) throw new Error("lo script non ha il permesso di usare Drive: ripubblicalo e autorizzalo");
    if (data?.results) throw new Error("lo script è una versione vecchia, senza la lettura dall'iPhone: copialo di nuovo dalle impostazioni e ripubblicalo");
    throw new Error(err);
  }
  if (Array.isArray(data.results)) throw new Error("lo script è una versione vecchia, senza la lettura dall'iPhone: copialo di nuovo dalle impostazioni e ripubblicalo");
  return data;
}

/** Appuntamenti creati dal telefono (vedi la funzione phone dello script). */
export async function callPhone(url: string, secret: string, phone: Record<string, unknown>): Promise<any> {
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "text/plain;charset=utf-8",
    body: JSON.stringify({ secret, phone }),
    throw: false,
  });
  let data: any;
  try {
    data = typeof res.json === "object" ? res.json : JSON.parse(res.text);
  } catch {
    throw new Error(`risposta non valida dallo script (HTTP ${res.status})`);
  }
  if (Array.isArray(data?.results)) throw new Error("vecchio");
  if (!data?.ok) throw new Error(String(data?.error ?? "errore sconosciuto"));
  return data;
}

/** Lo script da incollare in script.google.com (con la tua chiave già dentro). */
export function appsScript(secret: string): string {
  return `// Neo Pen → Google Calendar
// 1. Vai su https://script.google.com → Nuovo progetto, cancella tutto e incolla questo testo.
// 2. Salva, poi Esegui il deploy → Nuovo deployment → tipo "App web".
//    Esegui come: Me · Chi ha accesso: Chiunque. Autorizza l'accesso al calendario.
// 3. Per i task senza orario (Google Tasks): a sinistra "Servizi" (+) → Google Tasks API → Aggiungi.
// 4. Copia l'URL dell'app web (finisce con /exec) nelle impostazioni di Neo Pen.
//    (La lettura dall'iPhone usa anche Google Drive: al deploy Google chiederà di autorizzarlo.)
//    Se modifichi lo script: Esegui il deploy → Gestisci deployment → matita → Versione: Nuova versione.
const SECRET = ${JSON.stringify(secret)};

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "richiesta non valida" }); }
  if (req.secret !== SECRET) return out({ ok: false, error: "secret" });
  if (req.relay) {
    try { return out(relay(req.relay)); } catch (err) { return out({ ok: false, error: String(err) }); }
  }
  if (req.phone) {
    try { return out(phone(req.phone)); } catch (err) { return out({ ok: false, error: String(err) }); }
  }
  const cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
  if (!cal) return out({ ok: false, error: "calendar" });
  const results = (req.ops || []).map(function (op) {
    try { return run(cal, op); } catch (err) { return { ok: false, error: String(err) }; }
  });
  return out({ ok: true, results: results });
}

// ---- Pagine mandate dall'iPhone (Bluefy): restano in una cartella di Drive finché il PC le legge
function relayFolder() {
  const it = DriveApp.getFoldersByName("NeoPen-iPhone");
  return it.hasNext() ? it.next() : DriveApp.createFolder("NeoPen-iPhone");
}

function relay(r) {
  const folder = relayFolder();
  if (r.action === "ping") return { ok: true };
  if (r.action === "put") {
    (r.pages || []).forEach(function (p) {
      const name = p.id + ".json";
      const it = folder.getFilesByName(name);
      const f = it.hasNext() ? it.next() : folder.createFile(name, "{}", "application/json");
      f.setContent(JSON.stringify({ id: p.id, count: p.count, strokes: p.strokes }));
      f.setDescription(String(p.count));
    });
    return { ok: true, saved: (r.pages || []).length };
  }
  if (r.action === "list") {
    // il PC si fa vedere: finché è acceso, Obsidian sul telefono non trascrive (niente lavoro doppio né impostazioni in conflitto)
    const props = PropertiesService.getScriptProperties();
    if (r.device === "pc") props.setProperty("pcSeen", String(Date.now()));
    const pcSeen = Number(props.getProperty("pcSeen")) || 0;
    const files = folder.getFiles();
    const pages = [];
    while (files.hasNext()) {
      const f = files.next();
      if (/[.]json$/.test(f.getName())) pages.push({ id: f.getName().replace(/[.]json$/, ""), count: Number(f.getDescription()) || 0, updated: f.getLastUpdated().getTime() });
    }
    return { ok: true, pages: pages, pcSeen: pcSeen };
  }
  if (r.action === "get") {
    const it = folder.getFilesByName(r.id + ".json");
    if (!it.hasNext()) return { ok: false, error: "pagina non trovata" };
    return { ok: true, page: JSON.parse(it.next().getBlob().getDataAsString()) };
  }
  return { ok: false, error: "azione sconosciuta" };
}

// ---- Appuntamenti e attività creati dal telefono (PC spento): restano finché Obsidian non trascrive la pagina e li
// sostituisce con i suoi. Le attività senza orario vanno dove le manda il plugin (Todoist o Google Tasks).
function phone(r) {
  const props = PropertiesService.getScriptProperties();
  if (r.action === "config") {
    props.setProperties({
      calendarId: r.calendarId || "",
      minutes: String(r.minutes || 30),
      target: r.target || "none",
      todoistToken: r.todoistToken || "",
      todoistProject: r.todoistProject || "",
      tasksList: r.tasksList || "",
    });
    return { ok: true };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let all = {};
    try { all = JSON.parse(props.getProperty("phoneEvents") || "{}"); } catch (err) {}
    const calId = props.getProperty("calendarId");
    const cal = (calId ? CalendarApp.getCalendarById(calId) : null) || CalendarApp.getDefaultCalendar();
    if (r.action === "add") {
      const minutes = Number(props.getProperty("minutes")) || 30;
      const rec = all[r.page] || { upTo: 0, events: [] };
      let made = 0, todos = 0, todoError = "";
      (r.events || []).forEach(function (e) {
        const start = new Date(e.start);
        if (isNaN(start.getTime()) || !e.title) return;
        let end = e.end ? new Date(e.end) : null;
        if (!end || isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + minutes * 60000);
        const ev = cal.createEvent(e.title, start, end);
        ev.setTag("neopen-phone", r.page);
        ev.setDescription("Scritto a mano · dal telefono (Obsidian lo sostituisce quando trascrive la pagina)");
        rec.events.push({ kind: "event", id: ev.getId() });
        made++;
      });
      const target = props.getProperty("target") || "none";
      (r.todos || []).forEach(function (t) {
        if (!t.title || target === "none") return;
        try {
          if (target === "todoist") rec.events.push({ kind: "todoist", id: todoistAdd(props, t) });
          else {
            const res = runTask({ action: "upsert", kind: "task", list: props.getProperty("tasksList") || "", key: "phone-" + r.page + "-" + Date.now() + "-" + todos, title: t.title, date: t.date || "", description: "Scritto a mano · dal telefono" });
            if (!res.ok) throw new Error(res.error);
            rec.events.push({ kind: "task", id: res.id });
          }
          todos++;
        } catch (err) { todoError = String(err && err.message || err); }
      });
      rec.upTo = Math.max(rec.upTo || 0, Number(r.upTo) || 0);
      all[r.page] = rec;
      props.setProperty("phoneEvents", JSON.stringify(all));
      return { ok: true, created: made, todos: todos, todoError: todoError };
    }
    if (r.action === "list") {
      const pages = {};
      Object.keys(all).forEach(function (k) { pages[k] = { upTo: all[k].upTo, count: (all[k].events || []).length }; });
      return { ok: true, pages: pages };
    }
    if (r.action === "clear") {
      const rec = all[r.page];
      if (!rec) return { ok: true, removed: 0 };
      // tolti solo se Obsidian ha trascritto fino a quei tratti; quelli scritti dopo restano
      if (Number(r.upTo) < Number(rec.upTo)) return { ok: true, removed: 0, later: true };
      let n = 0;
      (rec.events || []).forEach(function (item) {
        const it = typeof item === "string" ? { kind: "event", id: item } : item;
        try {
          if (it.kind === "event") { const ev = cal.getEventById(it.id); if (ev) { ev.deleteEvent(); n++; } }
          else if (it.kind === "todoist") { todoist(props, "delete", "/tasks/" + it.id); n++; }
          else if (it.kind === "task" && typeof Tasks !== "undefined") { Tasks.Tasks.remove(taskList(props.getProperty("tasksList") || ""), it.id); n++; }
        } catch (err) {}
      });
      delete all[r.page];
      props.setProperty("phoneEvents", JSON.stringify(all));
      return { ok: true, removed: n };
    }
    return { ok: false, error: "azione sconosciuta" };
  } finally {
    lock.releaseLock();
  }
}

// Todoist (API ufficiale, con il token del plugin)
function todoist(props, method, path, body) {
  const token = props.getProperty("todoistToken");
  if (!token) throw new Error("manca il token di Todoist nel plugin");
  const bases = ["https://api.todoist.com/api/v1", "https://api.todoist.com/rest/v2"];
  for (let i = 0; i < bases.length; i++) {
    const opt = { method: method, headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true };
    if (body) { opt.contentType = "application/json"; opt.payload = JSON.stringify(body); }
    const res = UrlFetchApp.fetch(bases[i] + path, opt);
    const code = res.getResponseCode();
    if ((code === 410 || code === 404) && i === 0 && method !== "delete") continue;
    if (code === 401 || code === 403) throw new Error("token di Todoist non valido");
    let json = null;
    try { json = JSON.parse(res.getContentText() || "null"); } catch (err) {}
    return { status: code, json: json };
  }
  throw new Error("Todoist non risponde");
}

function todoistAdd(props, t) {
  let projectId = "";
  const name = (props.getProperty("todoistProject") || "").toLowerCase();
  if (name) {
    const r = todoist(props, "get", "/projects");
    const list = Array.isArray(r.json) ? r.json : (r.json && r.json.results) || [];
    const p = list.filter(function (x) { return String(x.name).toLowerCase() === name; })[0];
    if (p) projectId = String(p.id);
  }
  const body = { content: t.title, description: "Scritto a mano · dal telefono" };
  if (t.date) body.due_date = t.date;
  if (projectId) body.project_id = projectId;
  const r = todoist(props, "post", "/tasks", body);
  if (r.status >= 400 || !r.json || !r.json.id) throw new Error("Todoist ha risposto " + r.status);
  return String(r.json.id);
}

function run(cal, op) {
  if (op.action === "ping") return { ok: true, calendar: cal.getName(), tasks: typeof Tasks !== "undefined" };
  if (op.kind === "task") return runTask(op);
  let ev = find(cal, op);
  if (op.action === "delete") { if (ev) ev.deleteEvent(); return { ok: true }; }
  const title = (op.done ? "✓ " : "") + op.title;
  // cambia tipo (giornata intera ↔ orario) o stato (fatto ↔ da fare): si ricrea
  if (ev && (ev.isAllDayEvent() !== !!op.allDay || (ev.getTag("neopen-done") === "1") !== !!op.done)) { ev.deleteEvent(); ev = null; }
  if (!ev) {
    ev = op.allDay ? cal.createAllDayEvent(title, day(op.date)) : cal.createEvent(title, when(cal, op.startLocal, op.start), when(cal, op.endLocal, op.end));
    ev.setTag("neopen", op.key || "");
    if (op.done) ev.setColor(CalendarApp.EventColor.GRAY);
  } else {
    ev.setTitle(title);
    if (op.allDay) ev.setAllDayDate(day(op.date)); else ev.setTime(when(cal, op.startLocal, op.start), when(cal, op.endLocal, op.end));
  }
  ev.setTag("neopen-done", op.done ? "1" : "0");
  ev.setDescription(op.description || "");
  return { ok: true, id: ev.getId() };
}

// evento già creato: per id, oppure per chiave nei giorni vicini (niente doppioni)
function find(cal, op) {
  if (op.id) { try { const ev = cal.getEventById(op.id); if (ev) return ev; } catch (err) {} }
  if (!op.key || !op.date) return null;
  const d = day(op.date);
  const from = new Date(d.getTime() - 86400000), to = new Date(d.getTime() + 2 * 86400000);
  const list = cal.getEvents(from, to).filter(function (ev) { return ev.getTag("neopen") === op.key; });
  return list.length ? list[0] : null;
}

// ---- Google Tasks (servizio avanzato "Google Tasks API")
function runTask(op) {
  if (typeof Tasks === "undefined") return { ok: false, error: "tasks-service" };
  const list = taskList(op.list);
  const t = findTask(list, op);
  if (op.action === "delete") { if (t) Tasks.Tasks.remove(list, t.id); return { ok: true }; }
  const res = {
    title: op.title,
    notes: (op.description || "") + "\\n[neopen:" + op.key + "]",
    status: op.done ? "completed" : "needsAction",
    completed: op.done ? undefined : null,
    due: op.date ? op.date + "T00:00:00.000Z" : null,
  };
  const saved = t ? Tasks.Tasks.patch(res, list, t.id) : Tasks.Tasks.insert(res, list);
  return { ok: true, id: saved.id };
}

function taskList(name) {
  if (!name) return "@default";
  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  const found = lists.filter(function (l) { return l.title === name; })[0];
  return found ? found.id : Tasks.Tasklists.insert({ title: name }).id;
}

function findTask(list, op) {
  if (op.id) { try { const t = Tasks.Tasks.get(list, op.id); if (t && !t.deleted) return t; } catch (err) {} }
  if (!op.key) return null;
  let page;
  do {
    const r = Tasks.Tasks.list(list, { showCompleted: true, showHidden: true, maxResults: 100, pageToken: page });
    const hit = (r.items || []).filter(function (t) { return !t.deleted && (t.notes || "").indexOf("[neopen:" + op.key + "]") >= 0; })[0];
    if (hit) return hit;
    page = r.nextPageToken;
  } while (page);
  return null;
}

// "16:00" scritto a mano = le 16 nel fuso del TUO calendario (non in quello del PC)
function when(cal, local, iso) {
  if (local) return Utilities.parseDate(local, cal.getTimeZone(), "yyyy-MM-dd HH:mm");
  return new Date(iso);
}

function day(s) { const p = String(s).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Da eseguire una volta dall'editor (menu accanto a "Esegui" → provaTodoist): fa chiedere a Google il permesso di
// collegarsi a Todoist e controlla che risponda (200 = tutto a posto).
function provaTodoist() {
  const token = PropertiesService.getScriptProperties().getProperty("todoistToken");
  const r = UrlFetchApp.fetch("https://api.todoist.com/api/v1/projects", {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });
  Logger.log("Todoist risponde: " + r.getResponseCode() + (token ? "" : " (manca il token: apri Obsidian sul PC)"));
}
`;
}
