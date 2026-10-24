import { NativeModule, requireNativeModule } from 'expo';

import { BleSnapshot, NeoPenBleModuleEvents } from './NeoPenBle.types';

declare class NeoPenBleModule extends NativeModule<NeoPenBleModuleEvents> {
  getState(): Promise<BleSnapshot>;
  /** First time: look for a powered-on pen and remember it. */
  searchPen(): void;
  stopSearch(): void;
  forgetPen(): void;
  /** Closes the link (the pen stays remembered and reconnects at the next power-on). */
  disconnect(): void;
  /** Bytes for the pen, base64. */
  send(base64: string): void;
  /** A few extra seconds from iOS to finish work in the background; returns an id for endBackgroundTask. */
  beginBackgroundTask(name: string): number;
  endBackgroundTask(id: number): void;
  /** Lets the user choose the Obsidian vault folder (Files). Resolves with its name, or null if cancelled. */
  pickVaultFolder(): Promise<string | null>;
  /** Name of the chosen vault folder, or null. */
  vaultFolderName(): string | null;
  /** Markdown files of the vault (relative paths) with modification time in ms. */
  listVaultMarkdown(): Promise<{ path: string; mtime: number }[]>;
  /** Text of a file inside the vault folder, or null. */
  readVaultFile(path: string): Promise<string | null>;
  /** Writes a text file inside the vault folder (relative path). Returns "" or the error message. */
  writeVaultFile(path: string, text: string): string;
  /**
   * POST that goes on with the phone locked: tried at once, then (if iOS takes back the time) finished by iOS by
   * itself. Body from a file path; the answer in Documents/http/<id>.body and <id>.done, then the onHttpDone event.
   */
  startBackgroundPost(id: string, url: string, headers: Record<string, string>, bodyPath: string): boolean;
}

export default requireNativeModule<NeoPenBleModule>('NeoPenBle');
