// Pen packet format (protocol v2 of NeoLAB's official SDK):
//   STX(0xC0) · command · [result] · length (2 bytes, little-endian) · data · ETX(0xC1)
// Inside a packet, the bytes 0xC0, 0xC1 and 0x7D are written as 0x7D followed by (byte XOR 0x20).

export const STX = 0xc0;
export const ETX = 0xc1;
export const DLE = 0x7d;

/** Builds a packet for the pen (with escaping of special bytes). */
export class ByteWriter {
  readonly bytes: number[] = [];

  /** Raw byte, no escaping (only for STX and ETX). */
  raw(b: number): this {
    this.bytes.push(b & 0xff);
    return this;
  }

  put(b: number): this {
    b &= 0xff;
    if (b === STX || b === ETX || b === DLE) this.bytes.push(DLE, b ^ 0x20);
    else this.bytes.push(b);
    return this;
  }

  putArray(arr: ArrayLike<number>, length: number): this {
    for (let i = 0; i < length; i++) this.put(i < arr.length ? arr[i] : 0);
    return this;
  }

  putNull(n: number): this {
    for (let i = 0; i < n; i++) this.put(0);
    return this;
  }

  putShort(v: number): this {
    return this.put(v & 0xff).put((v >>> 8) & 0xff);
  }

  putInt(v: number): this {
    const u = v >>> 0;
    for (let i = 0; i < 4; i++) this.put((u >>> (8 * i)) & 0xff);
    return this;
  }

  putLong(v: number): this {
    let n = Math.floor(v);
    for (let i = 0; i < 8; i++) {
      const b = n % 256;
      this.put(b);
      n = (n - b) / 256;
    }
    return this;
  }

  /** Section and owner in 4 bytes: owner in the first 3 (little-endian), section in the fourth. */
  putSectionOwner(section: number, owner: number): this {
    return this.put(owner & 0xff).put((owner >>> 8) & 0xff).put((owner >>> 16) & 0xff).put(section & 0xff);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Reads packet data (little-endian). Past the end it returns zeros, like the official SDK. */
export class ByteReader {
  pos = 0;
  constructor(readonly data: Uint8Array) {}

  get remaining(): number {
    return Math.max(0, this.data.length - this.pos);
  }

  byte(): number {
    const v = this.pos < this.data.length ? this.data[this.pos] : 0;
    this.pos++;
    return v;
  }

  bytes(n: number): Uint8Array {
    const end = Math.min(this.data.length, this.pos + n);
    const out = this.pos < end ? this.data.slice(this.pos, end) : new Uint8Array(0);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }

  short(): number {
    return this.byte() | (this.byte() << 8);
  }

  int(): number {
    return (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
  }

  long(): number {
    const lo = this.int();
    const hi = this.int();
    return hi * 4294967296 + lo;
  }

  /** Fixed-length text (zeros removed). */
  string(n: number): string {
    const b = Array.from(this.bytes(n)).filter((x) => x !== 0);
    return decodeUtf8(b).trim();
  }

  sectionOwner(): { section: number; owner: number } {
    const b = [this.byte(), this.byte(), this.byte(), this.byte()];
    return { section: b[3], owner: b[0] + b[1] * 256 + b[2] * 65536 };
  }
}

/** Packet received from the pen. */
export interface Packet {
  cmd: number;
  /** Result (0 = ok); -1 if the command has none. */
  result: number;
  length: number;
  reader: ByteReader;
}

/** Reassembles packets from Bluetooth fragments (a packet can span several notifications). */
export class FrameParser {
  private buffer: number[] | null = null;
  private escape = false;

  feed(chunk: ArrayLike<number>): Packet[] {
    const out: Packet[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === STX) {
        this.buffer = [];
        this.escape = false;
      } else if (b === ETX) {
        if (this.buffer && this.buffer.length) out.push(FrameParser.packet(this.buffer));
        this.buffer = null;
        this.escape = false;
      } else if (b === DLE && !this.escape) {
        this.escape = true;
      } else if (this.escape) {
        this.buffer?.push(b ^ 0x20);
        this.escape = false;
      } else {
        this.buffer?.push(b);
      }
    }
    return out;
  }

  static packet(buf: number[]): Packet {
    const r = new ByteReader(Uint8Array.from(buf));
    const cmd = r.byte();
    // events (0x6X), PDS (0x73), offline packets (0x24) and firmware (0x32) have no result byte
    const hasResult = cmd >> 4 !== 0x6 && cmd !== 0x73 && cmd !== 0x24 && cmd !== 0x32;
    const result = hasResult ? r.byte() : -1;
    const length = r.short();
    const data = r.rest();
    return { cmd, result, length, reader: new ByteReader(data) };
  }
}

export function encodeUtf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

export function decodeUtf8(b: number[]): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    else {
      const cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      s += String.fromCodePoint(cp);
    }
  }
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Base64 → bytes (the native Bluetooth module sends bytes as base64). */
export function fromBase64(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_INDEX[s.charCodeAt(i) & 0xff];
    if (v < 0) continue; // padding, spaces
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function toBase64(b: ArrayLike<number>): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return s;
}
