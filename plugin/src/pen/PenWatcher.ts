// Collegamento automatico: ogni pochi secondi prova (in silenzio) a raggiungere la penna.
// Quando la trovi accesa (hai aperto il tappo) sincronizza subito; finché resta accesa
// risincronizza ogni N minuti. Se la penna è spenta il tentativo fallisce senza messaggi.

export interface WatcherDeps {
  enabled: () => boolean;
  /** Ogni quanto risincronizzare mentre la penna resta accesa (ms). */
  intervalMs: () => number;
  /** Penna già collegata o operazione in corso: non disturbare. */
  busy: () => boolean;
  /** Tentativo silenzioso: true se la penna c'era ed è stata sincronizzata. */
  attempt: () => Promise<boolean>;
}

export class PenWatcher {
  private timer: number | null = null;
  private running = false;
  private present = false;
  private lastOk = 0;

  constructor(private deps: WatcherDeps, private pollMs = 20000) {}

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => void this.tick(), this.pollMs);
    window.setTimeout(() => void this.tick(), 3000);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Sincronizzazione fatta a mano: conta come "penna trovata adesso". */
  notifySynced(): void {
    this.present = true;
    this.lastOk = Date.now();
  }

  get lastSync(): number {
    return this.lastOk;
  }

  async tick(): Promise<void> {
    if (this.running || !this.deps.enabled() || this.deps.busy()) return;
    // appena sincronizzata e (probabilmente) ancora accesa: aspetta l'intervallo
    if (this.present && Date.now() - this.lastOk < this.deps.intervalMs()) return;
    this.running = true;
    try {
      const ok = await this.deps.attempt();
      if (ok) this.notifySynced();
      else this.present = false;
    } catch {
      this.present = false;
    } finally {
      this.running = false;
    }
  }
}
