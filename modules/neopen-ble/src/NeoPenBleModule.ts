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
  /** POST that iOS finishes by itself with the app suspended. Body from a file path; the answer in Documents/http/<id>.body and <id>.done. */
  startBackgroundPost(id: string, url: string, headers: Record<string, string>, bodyPath: string): boolean;
}

export default requireNativeModule<NeoPenBleModule>('NeoPenBle');
