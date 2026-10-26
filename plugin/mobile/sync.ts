// Pagina «Neo Pen · iPhone» per Bluefy: legge la memoria della penna e lascia le pagine nuove nello
// script Google (cartella «NeoPen-iPhone» su Drive). Il PC con Obsidian le prende e le trascrive.
import { PenConnection, describeError } from "../src/pen/PenConnection";
import { PageKey, pageId } from "../src/types";

const $ = (id: string) => document.getElementById(id)!;
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* niente */
    }
  },
};
const SVC = ["000019f1-0000-1000-8000-00805f9b34fb", "4f99f138-9d53-5bfa-9e50-b147491afe68"];
const VERSION = "9";

// ---------- registro
const LOG_KEY = "neopen-sync-registro";
let lines: string[] = JSON.parse(store.get(LOG_KEY) ?? "[]");
const log = (m: string) => {
  lines.push(`${new Date().toLocaleTimeString("it-IT")}  ${m}`);
  if (lines.length > 400) lines = lines.slice(-400);
  store.set(LOG_KEY, JSON.stringify(lines));
  $("log").textContent = lines.slice().reverse().join("\n");
};
const where = () => (document.visibilityState === "visible" ? "davanti" : "BACKGROUND");

// ---------- configurazione (indirizzo e chiave dello script)
interface Cfg {
  url: string;
  secret: string;
}
const CFG_KEY = "neopen-sync-config";
let cfg: Cfg = JSON.parse(store.get(CFG_KEY) ?? '{"url":"","secret":""}');
// facoltativo: pagina#u=...&s=... riempie i campi da sola
try {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("u") && h.get("s")) {
    cfg = { url: h.get("u")!, secret: h.get("s")! };
    store.set(CFG_KEY, JSON.stringify(cfg));
    history.replaceState(null, "", location.pathname + location.search);
  }
} catch {
  /* niente */
}
($("url") as HTMLInputElement).value = cfg.url;
($("secret") as HTMLInputElement).value = cfg.secret;
const hasCfg = () => /^https:\/\/script\.google\.com\/.+\/exec/.test(cfg.url) && cfg.secret.length > 8;

// ---------- stato a video
function show(kind: "ok" | "work" | "warn" | "idle", main: string, sub = "") {
  const box = $("state");
  box.className = `state ${kind}`;
  $("stateMain").textContent = main;
  $("stateSub").textContent = sub;
}

// ---------- script
async function relay(r: Record<string, unknown>): Promise<any> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: cfg.secret, relay: r }),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error("lo script non ha risposto come previsto (controlla l'indirizzo e che sia pubblicato per «Chiunque»)");
  }
  if (!data?.ok) throw new Error(data?.error === "secret" ? "la chiave segreta non corrisponde" : String(data?.error ?? "errore dello script"));
  if (Array.isArray(data.results)) throw new Error("lo script sul PC è una versione vecchia: aggiornalo da Obsidian (Impostazioni → Neo Pen → Calendario)");
  return data;
}

// ---------- penna
const chooser = { available: true, cancel() {}, setQuiet() {}, dispose() {} };
const pen = new PenConnection(chooser as any);
pen.on("log", (m) => log(`penna: ${m}`));
pen.on("passwordRequest", () => show("warn", "La penna chiede la password", "Toglila da Neo Studio e riprova."));

const SENT_KEY = "neopen-sync-inviati";
const sent: Record<string, number> = JSON.parse(store.get(SENT_KEY) ?? "{}");
let device: BluetoothDevice | null = null;
let busy = false;
let lastRun = 0;

const round = (n: number) => Math.round(n * 100) / 100;

function limit<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = window.setTimeout(() => rej(new Error(`${what}: nessuna risposta in ${ms / 1000} s`)), ms);
    p.then(
      (v) => (window.clearTimeout(t), res(v)),
      (e) => (window.clearTimeout(t), rej(new Error(`${what}: ${describeError(e)}`))),
    );
  });
}

let chosen = false; // la penna è stata scelta dal selettore in questa apertura della pagina

async function knownPen(): Promise<BluetoothDevice | null> {
  if (device) return device;
  try {
    const list: BluetoothDevice[] = (await (navigator as any).bluetooth?.getDevices?.()) ?? [];
    device = list.find((d) => /neo|smartpen|m1/i.test(d.name ?? "")) ?? null;
    chosen = false;
    if (device) log(`penna ricordata da Bluefy: «${device.name}»`);
  } catch {
    /* non supportato */
  }
  return device;
}

/** Il selettore di Bluefy: serve un tocco, una volta sola. */
async function choosePen(): Promise<boolean> {
  try {
    device = await (navigator as any).bluetooth.requestDevice({ filters: SVC.map((s) => ({ services: [s] })), optionalServices: SVC });
    chosen = true;
    log(`penna scelta: «${device!.name ?? "senza nome"}»`);
    return true;
  } catch (e) {
    log(`selettore chiuso senza scegliere (${describeError(e)})`);
    return false;
  }
}

/** Una penna «ricordata» da Bluefy va prima rintracciata: si ascoltano i suoi annunci Bluetooth per qualche secondo. */
async function wake(d: BluetoothDevice): Promise<void> {
  const watch = (d as any).watchAdvertisements;
  if (typeof watch !== "function") return log("rintracciamento della penna non disponibile in questo Bluefy");
  let heard = false;
  const onAd = () => {
    heard = true;
  };
  d.addEventListener("advertisementreceived", onAd);
  try {
    await limit(watch.call(d), 4000, "rintracciamento");
  } catch (e) {
    log(`rintracciamento: ${describeError(e)}`);
  }
  for (let i = 0; i < 12 && !heard; i++) await new Promise((r) => window.setTimeout(r, 500));
  log(heard ? "penna rintracciata" : "penna non rintracciata (spenta o lontana?)");
  d.removeEventListener("advertisementreceived", onAd);
  try {
    (d as any).unwatchAdvertisements?.();
  } catch {
    /* niente */
  }
}

async function readAndSend(): Promise<{ pages: number; strokes: number }> {
  if (!chosen) await wake(device!);
  await limit(pen.connect({ device: device!, quiet: true }), 45000, "collegamento");
  log(`collegata (${where()})`);
  const keys: PageKey[] = await limit(pen.listMemory(), 30000, "elenco pagine");
  let pages = 0;
  let strokes = 0;
  for (const key of keys) {
    const id = pageId(key);
    // niente «interrompi se invariata»: su Bluefy dopo l'interruzione la penna smette di rispondere
    const read = () => limit(pen.downloadPage(key), 90000, `pagina ${key.note}/${key.page}`);
    let got = await read();
    if (got && !got.strokes.length) {
      // la penna a volte risponde «non posso» (dopo un collegamento interrotto): si riprova dopo una pausa
      for (let i = 0; i < 2 && got && !got.strokes.length; i++) {
        log(`pagina ${key.note}/${key.page}: la penna non l'ha mandata, riprovo (${i + 1}/2)`);
        await new Promise((r) => window.setTimeout(r, 2500));
        got = await read();
      }
    }
    if (!got) continue;
    if (got.strokes.length && sent[id] === got.count) {
      log(`pagina ${key.note}/${key.page}: invariata`);
      continue;
    }
    if (!got.strokes.length) {
      // letta vuota (capita se la pagina è andata in background durante la lettura): non va mandata, cancellerebbe quella buona
      log(`pagina ${key.note}/${key.page}: lettura vuota, la salto (riprovo al prossimo giro)`);
      continue;
    }
    show("work", "Invio le pagine al PC…", `pagina ${key.note}/${key.page}`);
    const clean = got.strokes.map((s) => ({ t: s.t, tip: s.tip, color: s.color, pts: s.pts.map(round) }));
    await relay({ action: "put", pages: [{ id, count: got.count, strokes: clean }] });
    sent[id] = got.count;
    store.set(SENT_KEY, JSON.stringify(sent));
    pages++;
    strokes += clean.length;
    log(`pagina ${key.note}/${key.page}: ${clean.length} tratti inviati`);
  }
  return { pages, strokes };
}

async function run(trigger: string): Promise<void> {
  if (busy) return;
  if (!(navigator as any).bluetooth) return show("warn", "Apri questa pagina in Bluefy", "Safari non può parlare con la penna.");
  if (!hasCfg()) return show("warn", "Mancano indirizzo e chiave", "Compila i campi qui sotto (li trovi nella nota «Collegamento iPhone» in Obsidian).");
  busy = true;
  lastRun = Date.now();
  $("go").setAttribute("disabled", "");
  $("choose").classList.add("hide");
  log(`avvio (${trigger}, ${where()})`);
  try {
    if (!(await knownPen())) {
      show("warn", "Scegli la penna", "Accendila, poi tocca il pulsante: serve solo la prima volta.");
      $("choose").classList.remove("hide");
      return;
    }
    show("work", "Mi collego alla penna…", "Tienila accesa e vicina.");
    const r = await readAndSend();
    const t = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    show("ok", r.pages ? `Fatto · ${r.pages} pagine inviate` : "Fatto · niente di nuovo", `${t} · puoi tornare alla Home`);
    log(r.pages ? `fine: ${r.pages} pagine, ${r.strokes} tratti` : "fine: niente di nuovo");
  } catch (e) {
    const msg = describeError(e);
    log(`non riuscito (${where()}): ${msg}`);
    // la penna "ricordata" da Bluefy a volte non si lascia usare: si riparte da una scelta nuova
    if (!chosen) {
      device = null;
      $("choose").classList.remove("hide");
      show("warn", "Non sono riuscito a collegarmi", "Accendi la penna (togli il tappo) e tocca «Scegli la penna».");
    } else if (/non risponde|nessuna risposta|disconnected|NetworkError|GATT/i.test(msg)) show("warn", "Penna spenta o lontana", "Togli il tappo, poi riprova.");
    else show("warn", "Non riuscito", msg);
  } finally {
    try {
      pen.disconnect();
    } catch {
      /* niente */
    }
    busy = false;
    $("go").removeAttribute("disabled");
  }
}

// ---------- eventi
$("go").addEventListener("click", () => void run("tocco"));
$("choose").addEventListener("click", async () => {
  if (await choosePen()) void run("scelta penna");
});
$("save").addEventListener("click", () => {
  cfg = { url: ($("url") as HTMLInputElement).value.trim(), secret: ($("secret") as HTMLInputElement).value.trim() };
  store.set(CFG_KEY, JSON.stringify(cfg));
  log("configurazione salvata");
  if (hasCfg()) void run("configurazione");
  else show("warn", "Indirizzo o chiave non validi", "L'indirizzo inizia con https://script.google.com e finisce con /exec.");
});
$("test").addEventListener("click", async () => {
  cfg = { url: ($("url") as HTMLInputElement).value.trim(), secret: ($("secret") as HTMLInputElement).value.trim() };
  store.set(CFG_KEY, JSON.stringify(cfg));
  try {
    await relay({ action: "ping" });
    show("ok", "Script raggiunto", "Indirizzo e chiave sono giusti.");
    log("prova script: ok");
  } catch (e) {
    show("warn", "Script non raggiungibile", describeError(e));
    log(`prova script: ${describeError(e)}`);
  }
});
$("copy").addEventListener("click", async () => {
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  log("registro copiato");
});
$("clear").addEventListener("click", () => {
  lines = [];
  store.set(LOG_KEY, "[]");
  $("log").textContent = "";
});
$("forget").addEventListener("click", () => {
  for (const k of Object.keys(sent)) delete sent[k];
  store.set(SENT_KEY, "{}");
  log("elenco delle pagine inviate azzerato: al prossimo giro le rimando tutte");
});

// Partenza automatica: all'apertura e ogni volta che la pagina torna davanti (es. da Comandi).
document.addEventListener("visibilitychange", () => {
  log(`la pagina è ora ${document.visibilityState === "visible" ? "davanti" : "in background"}`);
  if (document.visibilityState === "visible" && Date.now() - lastRun > 20_000) void run("pagina davanti");
});
window.addEventListener("pageshow", () => log("pagina mostrata"));
log(`pagina aperta (versione ${VERSION})`);
$("log").textContent = lines.slice().reverse().join("\n");
if (hasCfg()) void run("apertura");
else show("idle", "Prima configurazione", "Compila indirizzo e chiave qui sotto.");
