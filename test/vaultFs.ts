// Il vault su disco per i test del motore del plugin (al posto della cartella del vault sul telefono).
import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultEntry, VaultIO, VaultStat } from "../plugin/src/phone/io";

export class NodeVaultIO implements VaultIO {
  constructor(readonly root: string) {}

  private abs(p: string): string {
    return path.join(this.root, p === "/" ? "" : p);
  }

  private statOf(abs: string): VaultStat | null {
    try {
      const s = fs.statSync(abs);
      return { folder: s.isDirectory(), mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  scan(): VaultEntry[] {
    const out: VaultEntry[] = [];
    const walk = (rel: string) => {
      for (const name of fs.readdirSync(this.abs(rel))) {
        if (name.startsWith(".")) continue;
        const p = rel ? `${rel}/${name}` : name;
        const s = this.statOf(this.abs(p))!;
        out.push({ path: p, ...s });
        if (s.folder) walk(p);
      }
    };
    walk("");
    return out;
  }

  stat(p: string): VaultStat | null {
    return this.statOf(this.abs(p));
  }

  read(p: string): string | null {
    try {
      return fs.readFileSync(this.abs(p), "utf8");
    } catch {
      return null;
    }
  }

  write(p: string, text: string): void {
    fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
    fs.writeFileSync(this.abs(p), text);
  }

  readBinary(p: string): Uint8Array | null {
    try {
      return new Uint8Array(fs.readFileSync(this.abs(p)));
    } catch {
      return null;
    }
  }

  writeBinary(p: string, data: Uint8Array): void {
    fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
    fs.writeFileSync(this.abs(p), data);
  }

  mkdir(p: string): void {
    fs.mkdirSync(this.abs(p), { recursive: true });
  }

  remove(p: string): void {
    fs.rmSync(this.abs(p), { recursive: true, force: true });
  }

  rename(from: string, to: string): void {
    fs.mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    fs.renameSync(this.abs(from), this.abs(to));
  }

  list(dir: string): { files: string[]; folders: string[] } {
    const files: string[] = [];
    const folders: string[] = [];
    for (const name of fs.readdirSync(this.abs(dir))) {
      const p = dir && dir !== "/" ? `${dir}/${name}` : name;
      (fs.statSync(this.abs(p)).isDirectory() ? folders : files).push(p);
    }
    return { files, folders };
  }
}
