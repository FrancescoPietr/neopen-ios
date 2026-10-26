// Pagina di prova per Bluefy (iPhone): la penna si collega da sola ogni tot, anche col telefono in tasca?
// Non scrive niente da nessuna parte: legge solo la memoria della penna (come il plugin) e annota tutto nel registro.
import { PenConnection, describeError } from "../src/pen/PenConnection";
import { PageKey, pageId } from "../src/types";

const $ = (id: string) => document.getElementById(id)!;
const LOG_KEY = "neopen-prova-registro";
const COUNT_KEY = "neopen-prova-conteggi";
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
let lines: string[] = JSON.parse(store.get(LOG_KEY) ?? "[]");
const show = () => {
  $("log").textContent = lines.slice().reverse().join("\n");
};
const log = (m: string) => {
  const t = new Date().toLocaleTimeString("it-IT");
  lines.push(`${t}  ${m}`);
  if (lines.length > 600) lines = lines.slice(-600);
  store.set(LOG_KEY, JSON.stringify(lines));
  show();
};
const status = (m: string) => ($("status").textContent = m);
const where = () => (document.visibilityState === "visible" ? "app davanti" : "app in BACKGROUND");

const chooser = { available: true, cancel() {}, setQuiet() {}, dispose() {} };
const pen = new PenConnection(chooser as any);
pen.on("log", (m) => log(`penna: ${m}`));
pen.on("status", (s) => status(`${s.state}${s.name ? " · " + s.name : ""}`));
pen.on("passwordRequest", () => log("la penna chiede la password (questa prova non la gestisce)"));

const SVC = ["000019f1-0000-1000-8000-00805f9b34fb", "4f99f138-9d53-5bfa-9e50-b147491afe68"];
const counts: Record<string, number> = JSON.parse(store.get(COUNT_KEY) ?? "{}");
let device: BluetoothDevice | null = null; // la penna scelta: i tentativi automatici usano questa, senza selettore
let busy = false;
let timer: number | null = null;
let lastBeat = Date.now();
let everyMs = 60_000;

function setBusy(b: boolean) {
  busy = b;
  for (const id of ["connect", "diag"]) ($(id) as HTMLButtonElement).disabled = b;
}

/** Un'operazione che non può restare appesa per sempre. */
function limit<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = window.setTimeout(() => rej(new Error(`${what}: nessuna risposta in ${ms / 1000} s`)), ms);
    p.then(
      (v) => (window.clearTimeout(t), res(v)),
      (e) => (window.clearTimeout(t), rej(e)),
    );
  });
}

async function readMemory(): Promise<void> {
  const pages: PageKey[] = await pen.listMemory();
  let changed = 0;
  for (const key of pages) {
    const id = pageId(key);
    const got = await pen.downloadPage(key, (count) => counts[id] !== count);
    if (got) {
      counts[id] = got.count;
      changed++;
      log(`pagina ${key.note}/${key.page}: ${got.strokes.length} tratti letti`);
    }
  }
  store.set(COUNT_KEY, JSON.stringify(counts));
  log(`memoria letta: ${pages.length} pagine, ${changed} cambiate`);
}

/** Collegati alla penna memorizzata, leggi la memoria, scollegati. */
async function readPen(quiet: boolean): Promise<void> {
  if (!device) throw new Error("nessuna penna memorizzata");
  await limit(pen.connect({ device, quiet }), 45000, "collegamento");
  log(`collegata (${where()})`);
  await limit(readMemory(), 120000, "lettura memoria");
}

/** Il selettore di Bluefy: serve un tocco dell'utente, una volta sola. */
async function choosePen(): Promise<BluetoothDevice | null> {
  const bt = (navigator as any).bluetooth;
  if (!bt) {
    log("Web Bluetooth assente: apri questa pagina in Bluefy");
    return null;
  }
  try {
    const d = await bt.requestDevice({ filters: SVC.map((s) => ({ services: [s] })), optionalServices: SVC });
    log(`penna scelta: «${d.name ?? "senza nome"}»`);
    return d;
  } catch (e) {
    log(`selettore chiuso senza scegliere (${describeError(e)}). Se la penna non compariva: accendila, scrivi due righe e riprova`);
    return null;
  }
}

$("connect").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const d = await choosePen();
    if (!d) return;
    device = d;
    await readPen(false);
  } catch (e) {
    log(`collegamento non riuscito: ${describeError(e)}`);
  } finally {
    try {
      pen.disconnect();
    } catch {
      /* niente */
    }
    setBusy(false);
  }
});

async function autoAttempt(): Promise<void> {
  if (busy) return log("tentativo saltato: il precedente è ancora in corso");
  if (!device) {
    // la pagina potrebbe essere stata ricaricata da iOS: Bluefy forse ricorda ancora la penna
    try {
      const known: BluetoothDevice[] = (await (navigator as any).bluetooth?.getDevices?.()) ?? [];
      device = known.find((d) => /neo|smartpen|m1/i.test(d.name ?? "")) ?? null;
      if (device) log(`penna ripresa da Bluefy dopo il ricaricamento: «${device.name}»`);
    } catch {
      /* non supportato */
    }
  }
  if (!device) return log("tentativo saltato: prima tocca «Collega la penna» e scegli la penna");
  setBusy(true);
  try {
    await readPen(true);
  } catch (e) {
    log(`tentativo non riuscito (${where()}): ${describeError(e)}`);
  } finally {
    try {
      pen.disconnect();
    } catch {
      /* niente */
    }
    setBusy(false);
  }
}

function beat(): void {
  const now = Date.now();
  const late = now - lastBeat - everyMs;
  lastBeat = now;
  log(`battito · ${document.visibilityState === "visible" ? "davanti" : "BACKGROUND"}${late > 15000 ? ` · in ritardo di ${Math.round(late / 1000)} s (iOS ha messo in pausa la pagina)` : ""}`);
  void autoAttempt();
}

$("diag").addEventListener("click", async () => {
  const bt = (navigator as any).bluetooth;
  if (!bt) return log("diagnostica: Web Bluetooth assente");
  try {
    log(`diagnostica: adattatore disponibile = ${await bt.getAvailability?.()}`);
  } catch (e) {
    log(`diagnostica: getAvailability → ${describeError(e)}`);
  }
  try {
    const known = (await bt.getDevices?.()) ?? null;
    log(`diagnostica: penne ricordate da Bluefy = ${known ? known.map((d: any) => d.name).join(", ") || "nessuna" : "funzione non disponibile"}`);
  } catch (e) {
    log(`diagnostica: getDevices → ${describeError(e)}`);
  }
  log(`diagnostica: penna memorizzata in questa pagina = ${device?.name ?? "nessuna"}`);
});
$("start").addEventListener("click", () => {
  everyMs = Number(($("every") as HTMLSelectElement).value) * 1000;
  if (timer) window.clearInterval(timer);
  lastBeat = Date.now();
  timer = window.setInterval(beat, everyMs);
  log(`prova automatica avviata: un tentativo ogni ${everyMs / 1000} s${device ? "" : " (ATTENZIONE: nessuna penna scelta, tocca prima «Collega la penna»)"}`);
  $("start").textContent = "Prova automatica attiva ✓";
});
$("copy").addEventListener("click", async () => {
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    log("registro copiato");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    log("registro copiato");
  }
});
$("clear").addEventListener("click", () => {
  lines = [];
  store.set(LOG_KEY, "[]");
  show();
});
document.addEventListener("visibilitychange", () => log(`la pagina è ora ${document.visibilityState === "visible" ? "davanti" : "in background"}`));
window.addEventListener("pagehide", () => log("pagina nascosta (pagehide)"));
window.addEventListener("pageshow", () => log("pagina mostrata (pageshow)"));
log(`pagina aperta (versione 3) · Web Bluetooth ${(navigator as any).bluetooth ? "disponibile" : "NON disponibile (aprila in Bluefy)"}`);
show();
