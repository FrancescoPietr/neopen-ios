// Storage on the phone with expo-file-system: one JSON per page, settings, log.
import { Directory, File, Paths } from "expo-file-system";
import { PageFiles } from "../core/store";

/** Page files in Documents/pages (one JSON per page). */
export class DevicePageFiles implements PageFiles {
  private dir = new Directory(Paths.document, "pages");

  constructor() {
    this.dir.create({ intermediates: true, idempotent: true });
  }

  list(): string[] {
    return this.dir
      .list()
      .filter((f): f is File => f instanceof File && f.name.endsWith(".json"))
      .map((f) => f.name.replace(/\.json$/, ""));
  }

  read(id: string): string | null {
    const f = new File(this.dir, `${id}.json`);
    return f.exists ? f.textSync() : null;
  }

  write(id: string, text: string): void {
    const f = new File(this.dir, `${id}.json`);
    if (!f.exists) f.create({ overwrite: true });
    f.writeSync(text);
  }
}

/** Small JSON file in Documents (settings). */
export function readJson<T>(name: string, fallback: T): T {
  try {
    const f = new File(Paths.document, name);
    return f.exists ? { ...fallback, ...JSON.parse(f.textSync()) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown): void {
  const f = new File(Paths.document, name);
  if (!f.exists) f.create({ overwrite: true });
  f.writeSync(JSON.stringify(value));
}

/** Small text file in Documents (null if missing). */
export function readText(name: string): string | null {
  try {
    const f = new File(Paths.document, name);
    return f.exists ? f.textSync() : null;
  } catch {
    return null;
  }
}

/** Writes a small text file in Documents. Returns "" or the error. */
export function writeText(name: string, text: string): string {
  try {
    const f = new File(Paths.document, name);
    if (!f.exists) f.create({ overwrite: true });
    f.writeSync(text);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Log file Documents/registro.txt (shareable from the app); kept under ~1 MB. */
export class LogFile {
  readonly file = new File(Paths.document, "registro.txt");

  append(line: string): void {
    try {
      if (!this.file.exists) this.file.create({ overwrite: true });
      this.file.writeSync(line + "\n", { append: true });
      if ((this.file.size ?? 0) > 1_000_000) {
        const text = this.file.textSync();
        this.file.writeSync(text.slice(-500_000));
      }
    } catch {
      /* the log is only a help */
    }
  }
}
