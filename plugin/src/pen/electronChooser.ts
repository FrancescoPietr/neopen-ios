// In Electron (Obsidian desktop) navigator.bluetooth.requestDevice() non mostra
// nessuna finestra di scelta: il processo principale emette l'evento
// "select-bluetooth-device" e qualcuno deve rispondere con l'id del dispositivo.
// Se nessuno ascolta, le versioni recenti di Electron annullano la richiesta.
//
// Un plugin vive nel processo "renderer", quindi proviamo ad agganciarci
// all'evento tramite il modulo "remote" che Obsidian espone.

type Log = (msg: string) => void;

interface BtDevice {
  deviceName?: string;
  deviceId: string;
}

export interface ChooserHandle {
  available: boolean;
  /** Annulla una ricerca in corso (se Electron sta ancora aspettando una scelta). */
  cancel(): void;
  /** Ricerche automatiche: niente messaggi nel registro. */
  setQuiet(q: boolean): void;
  dispose(): void;
}

const PEN_NAME = /neo|smartpen|nwp|m1|lamy/i;

function getRemote(): any | null {
  const req = (window as any).require as ((m: string) => any) | undefined;
  if (!req) return null;
  try {
    const electron = req("electron");
    if (electron?.remote) return electron.remote;
  } catch {
    /* ignora */
  }
  try {
    return req("@electron/remote");
  } catch {
    return null;
  }
}

export function installElectronChooser(log: Log): ChooserHandle {
  const remote = getRemote();
  if (!remote?.getCurrentWebContents) {
    log("Modulo Electron 'remote' non disponibile: provo senza gestore di scelta.");
    return { available: false, cancel() {}, setQuiet() {}, dispose() {} };
  }

  let wc: any;
  try {
    wc = remote.getCurrentWebContents();
  } catch (e) {
    log(`Impossibile ottenere webContents: ${String(e)}`);
    return { available: false, cancel() {}, setQuiet() {}, dispose() {} };
  }

  let pendingCallback: ((id: string) => void) | null = null;
  let answered = false;
  let lastNames = "";
  let quiet = false;

  const handler = (event: any, devices: BtDevice[], callback: (id: string) => void) => {
    // Con "remote" l'evento arriva in modo asincrono: preventDefault può arrivare tardi.
    // In quel caso Electron sceglie da solo il primo dispositivo filtrato, che con
    // il filtro sul servizio della penna è comunque la penna.
    try {
      event?.preventDefault?.();
    } catch {
      /* ignora */
    }
    pendingCallback = callback;
    const names = devices.map((d) => d.deviceName || d.deviceId).join(", ");
    if (names !== lastNames && !quiet) {
      log(devices.length ? `Dispositivi trovati: ${names}` : "Ricerca dispositivi in corso…");
      lastNames = names;
    }
    if (!devices.length || answered) return;
    const pick = devices.find((d) => PEN_NAME.test(d.deviceName ?? "")) ?? devices[0];
    answered = true;
    if (!quiet) log(`Seleziono: ${pick.deviceName || pick.deviceId}`);
    try {
      callback(pick.deviceId);
    } catch (e) {
      log(`Errore nella selezione: ${String(e)}`);
    }
    // pronto per la prossima ricerca
    setTimeout(() => {
      answered = false;
      lastNames = "";
      pendingCallback = null;
    }, 1500);
  };

  try {
    wc.on("select-bluetooth-device", handler);
    log("Gestore 'select-bluetooth-device' installato.");
  } catch (e) {
    log(`Impossibile installare il gestore: ${String(e)}`);
    return { available: false, cancel() {}, setQuiet() {}, dispose() {} };
  }

  return {
    available: true,
    cancel() {
      if (pendingCallback) {
        try {
          pendingCallback("");
        } catch {
          /* ignora */
        }
        pendingCallback = null;
      }
      answered = false;
      lastNames = "";
    },
    setQuiet(q: boolean) {
      quiet = q;
    },
    dispose() {
      try {
        wc.removeListener("select-bluetooth-device", handler);
      } catch {
        /* ignora */
      }
    },
  };
}

/**
 * Esegue `fn` come se l'utente avesse appena cliccato: Chromium permette di cercare
 * dispositivi Bluetooth solo dopo un gesto dell'utente, ma il collegamento automatico
 * (penna accesa → sincronizza) parte da un timer. Electron permette di eseguire codice
 * nella pagina "con gesto utente" tramite executeJavaScript(…, true).
 */
export async function withUserGesture<T>(fn: () => Promise<T>): Promise<T> {
  const navAct = (navigator as any).userActivation;
  if (navAct?.isActive) return fn();
  const remote = getRemote();
  let wc: any = null;
  try {
    wc = remote?.getCurrentWebContents?.();
  } catch {
    wc = null;
  }
  if (!wc?.executeJavaScript) return fn();
  const slot = `__neopenGesture_${Math.random().toString(36).slice(2)}`;
  let ran = false;
  let result: T | undefined;
  let error: unknown;
  (window as any)[slot] = async () => {
    ran = true;
    try {
      result = await fn();
    } catch (e) {
      error = e;
    }
    return true;
  };
  try {
    await wc.executeJavaScript(`window["${slot}"] ? window["${slot}"]() : false`, true);
  } catch {
    /* ignora: si riprova senza gesto qui sotto */
  } finally {
    delete (window as any)[slot];
  }
  if (!ran) return fn();
  if (error) throw error;
  return result as T;
}
