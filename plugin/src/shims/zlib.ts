// Shim di "zlib" (Node) basato su fflate: funziona sia su desktop sia su mobile.
// I callback sono chiamati in modo sincrono, così i messaggi dell'SDK arrivano in ordine
// (OFFLINE_DATA_SEND_SUCCESS prima di OFFLINE_DATA_SEND_STATUS = 100).
import { decompressSync, zlibSync } from "fflate";

type Cb = (err: Error | null, res: Uint8Array) => void;

export function unzip(input: Uint8Array, cb: Cb): void {
  try {
    cb(null, decompressSync(input));
  } catch (e) {
    cb(e as Error, new Uint8Array());
  }
}

export function deflate(input: Uint8Array, optsOrCb: any, maybeCb?: Cb): void {
  const cb: Cb = typeof optsOrCb === "function" ? optsOrCb : (maybeCb as Cb);
  const level = typeof optsOrCb === "object" && optsOrCb?.level != null ? optsOrCb.level : 6;
  try {
    cb(null, zlibSync(input, { level }));
  } catch (e) {
    cb(e as Error, new Uint8Array());
  }
}

export default { unzip, deflate };
