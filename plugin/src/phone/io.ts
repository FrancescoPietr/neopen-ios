// Il vault visto dall'app del telefono (NeoTransfer), che fa girare il motore del plugin senza Obsidian.
// Percorsi relativi alla cartella del vault, con "/". Tutto sincrono: sul telefono sono file locali.

export interface VaultStat {
  folder: boolean;
  /** ms */
  mtime: number;
  ctime: number;
  size: number;
}

export interface VaultEntry extends VaultStat {
  path: string;
}

export interface VaultIO {
  /** Tutti i file e le cartelle del vault, escluse le cartelle nascoste (.obsidian, .trash…), come fa Obsidian. */
  scan(): VaultEntry[];
  stat(path: string): VaultStat | null;
  /** Testo del file, o null se non c'è. */
  read(path: string): string | null;
  /** Scrive (crea le cartelle che mancano). Errore → eccezione. */
  write(path: string, text: string): void;
  readBinary(path: string): Uint8Array | null;
  writeBinary(path: string, data: Uint8Array): void;
  mkdir(path: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  /** Contenuto di una cartella (percorsi completi), anche nascosta. */
  list(dir: string): { files: string[]; folders: string[] };
}

/** Richiesta HTTP del plugin (come requestUrl di Obsidian). */
export interface HttpRequest {
  url: string;
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}
