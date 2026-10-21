// Neo Smartpen protocol v2, ported from NeoLAB's official web SDK (web_pen_sdk: PenRequestV2 and
// PenClientParserV2), which the Obsidian plugin already uses with this pen. Only what we need:
// connection, settings, password, clock, live strokes, offline memory.

import { inflate, inflateRaw } from "pako";
import { ByteReader, ByteWriter, ETX, FrameParser, Packet, STX, encodeUtf8 } from "./bytes";
import { PageKey, PenSettings, PenVersion, Stroke, cleaned, despiked, isValidKey, pointCount, sameKey } from "./models";

export const Cmd = {
  versionRequest: 0x01,
  versionResponse: 0x81,
  passwordRequest: 0x02,
  passwordResponse: 0x82,
  settingInfoRequest: 0x04,
  settingInfoResponse: 0x84,
  settingChangeRequest: 0x05,
  settingChangeResponse: 0x85,
  lowBatteryEvent: 0x61,
  shutdownEvent: 0x62,
  onlineDataRequest: 0x11,
  onlineDataResponse: 0x91,
  penUpDownEvent: 0x63,
  paperInfoEvent: 0x64,
  penDotEvent: 0x65,
  penErrorEvent: 0x68,
  newPenDownEvent: 0x69,
  newPenUpEvent: 0x6a,
  newPaperInfoEvent: 0x6b,
  newPenDotEvent: 0x6c,
  newPenErrorEvent: 0x6d,
  penHoverEvent: 0x6f,
  offlineNoteListRequest: 0x21,
  offlineNoteListResponse: 0xa1,
  offlinePageListRequest: 0x22,
  offlinePageListResponse: 0xa2,
  offlineDataRequest: 0x23,
  offlineDataResponse: 0xa3,
  offlinePacket: 0x24,
  offlinePacketResponse: 0xa4,
} as const;

function build(cmd: number, body: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter();
  w.raw(STX).put(cmd);
  body(w);
  w.raw(ETX);
  return w.toUint8Array();
}

/** Requests for the pen (ready-made packets, with STX/ETX and escaping). */
export const PenRequest = {
  /** First request after connecting: who are you? (supported protocol version: 2.18) */
  version: () =>
    build(Cmd.versionRequest, (w) => w.putShort(42).putNull(16).put(0xf0).put(0x01).putArray(encodeUtf8("0.0.0.0"), 16).putArray(encodeUtf8("2.18"), 8)),

  penStatus: () => build(Cmd.settingInfoRequest, (w) => w.putShort(0)),

  password: (pw: string) => build(Cmd.passwordRequest, (w) => w.putShort(16).putArray(encodeUtf8(pw), 16)),

  /** Pen clock = phone time (stroke times depend on it). */
  setTime: (ms: number) => build(Cmd.settingChangeRequest, (w) => w.putShort(9).put(1).putLong(ms)),

  /** Live strokes from all notebooks. (While connected like this, the pen does NOT store them in memory.) */
  onlineAllNotes: () => build(Cmd.onlineDataRequest, (w) => w.putShort(2).put(0xff).put(0xff)),

  /** Notebooks in the pen's memory. */
  noteList: () => build(Cmd.offlineNoteListRequest, (w) => w.putShort(4).putArray([0xff, 0xff, 0xff, 0xff], 4)),

  /** Pages of a notebook in the pen's memory. */
  pageList: (section: number, owner: number, note: number) =>
    build(Cmd.offlinePageListRequest, (w) => w.putShort(8).putSectionOwner(section, owner).putInt(note)),

  /** Stored strokes of some pages. With `remove` the pen deletes the pages from its memory after sending them. */
  offlineData: (section: number, owner: number, note: number, pages: number[], remove: boolean) =>
    build(Cmd.offlineDataRequest, (w) => {
      w.putShort(14 + pages.length * 4).put(remove ? 1 : 2).put(0x01).putSectionOwner(section, owner).putInt(note).putInt(pages.length);
      for (const p of pages) w.putInt(p);
    }),

  /** Acknowledges an offline packet. `end` = stop sending. */
  offlineAck: (index: number, success = true, end = false) =>
    build(Cmd.offlinePacketResponse, (w) => w.put(success ? 0 : 1).putShort(3).putShort(index).put(end ? 0 : 1)),
};

/** What the pen says, already decoded. */
export type PenEvent =
  | { type: "version"; version: PenVersion }
  | { type: "settings"; settings: PenSettings }
  | { type: "passwordResult"; ok: boolean; retry: number; reset: number }
  | { type: "settingChanged"; setting: number; ok: boolean }
  | { type: "lowBattery"; level: number }
  | { type: "powerOff"; reason: number }
  | { type: "onlineDataSet"; ok: boolean }
  | { type: "noteList"; notes: PageKey[] } // page = 0
  | { type: "pageList"; section: number; owner: number; note: number; pages: number[] }
  /** Start of a transfer from memory: how many strokes and bytes. */
  | { type: "offlineStart"; strokes: number; bytes: number }
  /** The pen has nothing to send for that request (or refused). */
  | { type: "offlineFailure" }
  /** A packet of strokes from memory. `index` is needed for the ack; `last` = last packet. */
  | { type: "offlineChunk"; index: number; key: PageKey | null; strokes: { key: PageKey; stroke: Stroke }[]; last: boolean; damaged: boolean }
  /** Finished stroke, received live. */
  | { type: "liveStroke"; key: PageKey; stroke: Stroke }
  | { type: "unknown"; cmd: number; result: number };

/** Like Node's `zlib.unzip`: detects gzip or zlib headers by itself; otherwise raw DEFLATE. */
export function unzip(data: Uint8Array): Uint8Array {
  const zlibHeader = data.length >= 2 && (data[0] & 0x0f) === 8 && (data[0] * 256 + data[1]) % 31 === 0;
  const gzipHeader = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
  return zlibHeader || gzipHeader ? inflate(data) : inflateRaw(data);
}

/** Decodes the bytes coming from the pen and returns events. */
export class PenParser {
  private frames = new FrameParser();
  // live stroke being built
  private liveKey: PageKey | null = null;
  private liveTime = -1;
  private liveTip = 0;
  private liveColor = 0;
  private live: Stroke | null = null;

  reset(): void {
    this.frames = new FrameParser();
    this.liveKey = null;
    this.liveTime = -1;
    this.live = null;
  }

  feed(chunk: ArrayLike<number>): PenEvent[] {
    const out: PenEvent[] = [];
    for (const p of this.frames.feed(chunk)) out.push(...this.parse(p));
    return out;
  }

  /** The pen disconnected in the middle of a stroke: that stroke is closed with what there is. */
  flushLive(): PenEvent[] {
    const e = this.finishLive();
    return e ? [e] : [];
  }

  parse(p: Packet): PenEvent[] {
    const r = p.reader;
    switch (p.cmd) {
      case Cmd.versionResponse: {
        if (p.result !== 0) return [{ type: "unknown", cmd: p.cmd, result: p.result }];
        const deviceName = r.string(16);
        const firmware = r.string(16);
        const protocolVersion = r.string(8);
        const subName = r.string(16);
        r.short(); // device type
        const mac = Array.from(r.bytes(6), (b) => b.toString(16).padStart(2, "0")).join("");
        return [{ type: "version", version: { deviceName, firmware, protocolVersion, subName, mac } }];
      }
      case Cmd.settingInfoResponse: {
        if (p.result !== 0) return [{ type: "unknown", cmd: p.cmd, result: p.result }];
        const s: PenSettings = {
          locked: r.byte() === 1,
          resetCount: r.byte(),
          retryCount: r.byte(),
          timestamp: r.long(),
          autoShutdown: r.short(),
          maxForce: r.short(),
          usedMemory: r.byte(),
          capPowerOff: r.byte() === 1,
          autoPowerOn: r.byte() === 1,
          beep: r.byte() === 1,
          hover: r.byte() === 1,
          battery: r.byte(),
          offlineData: r.byte() === 1,
        };
        return [{ type: "settings", settings: s }];
      }
      case Cmd.passwordResponse: {
        const status = r.byte();
        const retry = r.byte();
        const reset = r.byte();
        return [{ type: "passwordResult", ok: p.result === 0 && status === 1, retry, reset }];
      }
      case Cmd.settingChangeResponse: {
        const setting = r.byte();
        const ok = r.byte() === 0 && p.result === 0;
        return [{ type: "settingChanged", setting, ok }];
      }
      case Cmd.lowBatteryEvent:
        return [{ type: "lowBattery", level: r.byte() }];
      case Cmd.shutdownEvent: {
        const out = this.flushLive();
        out.push({ type: "powerOff", reason: r.byte() });
        return out;
      }
      case Cmd.onlineDataResponse:
        return [{ type: "onlineDataSet", ok: p.result === 0 }];
      case Cmd.offlineNoteListResponse: {
        if (p.result !== 0) return [{ type: "noteList", notes: [] }];
        const n = r.short();
        const notes: PageKey[] = [];
        for (let i = 0; i < n; i++) {
          const so = r.sectionOwner();
          notes.push({ section: so.section, owner: so.owner, note: r.int(), page: 0 });
        }
        return [{ type: "noteList", notes }];
      }
      case Cmd.offlinePageListResponse: {
        const so = r.sectionOwner();
        const note = r.int();
        const n = p.result === 0 ? r.short() : 0;
        const pages: number[] = [];
        for (let i = 0; i < n; i++) pages.push(r.int());
        return [{ type: "pageList", section: so.section, owner: so.owner, note, pages }];
      }
      case Cmd.offlineDataResponse: {
        const strokes = r.int();
        const bytes = r.int();
        r.byte(); // compressed?
        if (p.result !== 0 || bytes <= 0) return [{ type: "offlineFailure" }];
        return [{ type: "offlineStart", strokes, bytes }];
      }
      case Cmd.offlinePacket:
        return [this.parseOfflinePacket(r)];

      // ---- live
      case Cmd.newPenDownEvent: {
        const out = this.flushLive();
        r.byte(); // event counter
        this.liveTime = r.long();
        this.liveTip = r.byte() === 0 ? 0 : 1;
        this.liveColor = r.int();
        this.live = { t: this.liveTime, tip: this.liveTip, color: this.liveColor, pts: [] };
        return out;
      }
      case Cmd.penUpDownEvent: {
        const isDown = r.byte() === 0;
        const out = this.flushLive();
        if (isDown) {
          this.liveTime = r.long();
          this.liveTip = r.byte() === 0 ? 0 : 1;
          this.liveColor = r.int();
          this.live = { t: this.liveTime, tip: this.liveTip, color: this.liveColor, pts: [] };
        }
        return out;
      }
      case Cmd.newPenUpEvent:
        return this.flushLive();
      case Cmd.paperInfoEvent:
      case Cmd.newPaperInfoEvent: {
        if (p.cmd === Cmd.newPaperInfoEvent) r.byte();
        const so = r.sectionOwner();
        const key: PageKey = { section: so.section, owner: so.owner, note: r.int(), page: r.int() };
        const out: PenEvent[] = [];
        // page changed in the middle of a stroke: the stroke is closed and restarts on the new page
        if (this.live && this.live.pts.length && this.liveKey && !sameKey(this.liveKey, key)) {
          out.push(...this.flushLive());
          this.live = { t: this.liveTime, tip: this.liveTip, color: this.liveColor, pts: [] };
        }
        this.liveKey = key;
        return out;
      }
      case Cmd.penDotEvent:
      case Cmd.newPenDotEvent: {
        if (p.cmd === Cmd.newPenDotEvent) r.byte();
        const timeAdd = r.byte();
        const force = r.short();
        const xi = r.short();
        const yi = r.short();
        const fx = r.byte();
        const fy = r.byte();
        if (this.liveTime >= 0) this.liveTime += timeAdd;
        if (!this.liveKey || !isValidKey(this.liveKey)) return [];
        if (!this.live) {
          // dot without pen-down (the pen-down got lost): the stroke starts here
          const t = this.liveTime > 10000 ? this.liveTime : Date.now();
          this.live = { t, tip: this.liveTip, color: this.liveColor, pts: [] };
        }
        this.live.pts.push(xi + fx * 0.01, yi + fy * 0.01, force);
        return [];
      }
      case Cmd.penHoverEvent:
      case Cmd.penErrorEvent:
      case Cmd.newPenErrorEvent:
        return [];
      default:
        return [{ type: "unknown", cmd: p.cmd, result: p.result }];
    }
  }

  private finishLive(): PenEvent | null {
    const s = this.live;
    this.live = null;
    const key = this.liveKey;
    if (!s || !key || !isValidKey(key)) return null;
    const clean = despiked(cleaned(s));
    if (pointCount(clean) < 1) return null;
    return { type: "liveStroke", key: { ...key }, stroke: clean };
  }

  private parseOfflinePacket(r: ByteReader): PenEvent {
    const index = r.short();
    const compressed = r.byte() === 1;
    const before = r.short();
    const after = r.short();
    const position = r.byte(); // 0 start, 1 middle, 2 end
    const so = r.sectionOwner();
    const note = r.int();
    const strokeCount = r.short();
    const size = compressed ? after : before;
    const raw = size > 0 ? r.bytes(size) : r.rest();
    const last = position === 2;
    let payload = raw;
    if (compressed) {
      try {
        payload = unzip(raw);
      } catch {
        return { type: "offlineChunk", index, key: null, strokes: [], last, damaged: true };
      }
    }
    const pr = new ByteReader(payload);
    const strokes: { key: PageKey; stroke: Stroke }[] = [];
    let firstKey: PageKey | null = null;
    for (let i = 0; i < strokeCount; i++) {
      if (pr.remaining < 27) break;
      const page = pr.int();
      let time = pr.long();
      pr.long(); // end of stroke
      const tip = pr.byte();
      const color = pr.int();
      const dots = pr.short();
      const pts: number[] = [];
      // like the plugin: the stroke takes the time of its first point
      let t0 = time;
      for (let j = 0; j < dots; j++) {
        const dt = pr.byte();
        const force = pr.short();
        const x = pr.short();
        const y = pr.short();
        const fx = pr.byte();
        const fy = pr.byte();
        pr.byte(); // tilt x
        pr.byte(); // tilt y
        pr.short(); // twist
        pr.short(); // reserved
        pr.byte(); // checksum
        time += dt;
        if (j === 0) t0 = time;
        pts.push(x + fx * 0.01, y + fy * 0.01, force);
      }
      const key: PageKey = { section: so.section, owner: so.owner, note, page };
      if (!firstKey) firstKey = key;
      const s = cleaned({ t: t0, tip: tip === 0 ? 0 : 1, color, pts });
      if (pointCount(s) >= 1 && isValidKey(key)) strokes.push({ key, stroke: s });
    }
    return { type: "offlineChunk", index, key: firstKey, strokes, last, damaged: false };
  }
}
