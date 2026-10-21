// Simulated pen: answers commands like the Neo Smartpen (protocol v2), with offline memory, per-packet acks,
// live mode and password. To test PenSession without Bluetooth.
import { ByteReader } from "../src/core/bytes";
import { PageKey, Stroke, pageId, pointCount } from "../src/core/models";
import { PenLink, PenSession } from "../src/core/session";

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const le64 = (v: number) => { const o: number[] = []; let n = v; for (let i = 0; i < 8; i++) { const b = n % 256; o.push(b); n = (n - b) / 256; } return o; };
const so = (section: number, owner: number) => [owner & 0xff, (owner >> 8) & 0xff, (owner >> 16) & 0xff, section & 0xff];
const fixed = (s: string, n: number) => [...Buffer.from(s), ...new Array(n).fill(0)].slice(0, n);
const frac = (v: number) => Math.round((v - Math.floor(v)) * 100);

function packet(cmd: number, data: number[], result: number | null = 0): number[] {
  const hasResult = cmd >> 4 !== 0x6 && cmd !== 0x73 && cmd !== 0x24 && cmd !== 0x32;
  const body = [cmd, ...(hasResult ? [result ?? 0] : []), ...le16(data.length), ...data];
  const out = [0xc0];
  for (const b of body) if (b === 0xc0 || b === 0xc1 || b === 0x7d) out.push(0x7d, b ^ 0x20); else out.push(b);
  out.push(0xc1);
  return out;
}

export class FakePen implements PenLink {
  session: PenSession | null = null;
  memory = new Map<string, { key: PageKey; strokes: Stroke[] }>();
  password: string | null = null;
  strokesPerPacket = 3;
  /** "Powers off" after sending this many offline packets (null = never). */
  powerOffAfterPackets: number | null = null;
  /** Pages for which the pen answers "nothing to send" the first N times. */
  refuseTimes = new Map<string, number>();
  mute = false;

  acks = 0;
  endAcks = 0;
  requestedPages: PageKey[] = [];
  deletedPages: PageKey[] = [];
  liveOn = false;
  clockSet = 0;
  private packetsSent = 0;
  private queue: number[][] = [];
  private unlocked = true;

  put(key: PageKey, strokes: Stroke[]) { this.memory.set(pageId(key), { key, strokes }); }
  lock() { this.unlocked = this.password === null; }

  send(bytes: Uint8Array): void {
    let buf: number[] | null = null;
    let esc = false;
    for (const b of bytes) {
      if (b === 0xc0) { buf = []; esc = false; }
      else if (b === 0xc1) { if (buf) this.handle(Uint8Array.from(buf)); buf = null; }
      else if (b === 0x7d && !esc) esc = true;
      else if (esc) { buf?.push(b ^ 0x20); esc = false; }
      else buf?.push(b);
    }
  }

  private handle(f: Uint8Array) {
    if (this.mute) return;
    const r = new ByteReader(f);
    const cmd = r.byte();
    if (cmd === 0xa4) r.byte();
    r.short();
    switch (cmd) {
      case 0x01: return this.reply(packet(0x81, [...fixed("NWP-F51", 16), ...fixed("1.10", 16), ...fixed("2.18", 8), ...fixed("M1+", 16), 1, 0, 1, 2, 3, 4, 5, 6, 1, 0, 0, 1, 2]));
      case 0x04: return this.reply(packet(0x84, [this.password !== null && !this.unlocked ? 1 : 0, 10, 0, ...le64(1792000000000), 20, 0, 0xff, 0x03, 12, 1, 1, 0, 0, 77, 1, 0]));
      case 0x02: {
        const ok = r.string(16) === this.password;
        if (ok) this.unlocked = true;
        return this.reply(packet(0x82, [ok ? 1 : 0, ok ? 0 : 1, 10]));
      }
      case 0x05: {
        const type = r.byte();
        if (type === 1) this.clockSet = r.long();
        return this.reply(packet(0x85, [type, 0]));
      }
      case 0x11: this.liveOn = true; return this.reply(packet(0x91, []));
      case 0x21: {
        const notes = new Map<string, PageKey>();
        for (const { key } of this.memory.values()) notes.set(`${key.section}_${key.owner}_${key.note}`, { ...key, page: 0 });
        const list = [...notes.values()].sort((a, b) => a.note - b.note);
        return this.reply(packet(0xa1, [...le16(list.length), ...list.flatMap((n) => [...so(n.section, n.owner), ...le32(n.note)])]));
      }
      case 0x22: {
        const s = r.sectionOwner();
        const note = r.int();
        const pages = [...this.memory.values()].map((m) => m.key).filter((k) => k.section === s.section && k.owner === s.owner && k.note === note).map((k) => k.page).sort((a, b) => a - b);
        return this.reply(packet(0xa2, [...so(s.section, s.owner), ...le32(note), ...le16(pages.length), ...pages.flatMap(le32)]));
      }
      case 0x23: {
        const remove = r.byte() === 1;
        r.byte();
        const s = r.sectionOwner();
        const note = r.int();
        const n = r.int();
        for (let i = 0; i < n; i++) {
          const key = { section: s.section, owner: s.owner, note, page: r.int() };
          this.requestedPages.push(key);
          this.startTransfer(key, remove);
        }
        return;
      }
      case 0xa4: {
        r.short();
        if (r.byte() === 1) { this.acks++; this.sendNext(); } else { this.endAcks++; this.queue = []; }
        return;
      }
    }
  }

  /** In pieces, like Bluetooth notifications, and a moment later. */
  private reply(p: number[]) {
    const chunks: number[][] = [];
    for (let i = 0; i < p.length; i += 20) chunks.push(p.slice(i, i + 20));
    setTimeout(() => { for (const c of chunks) this.session?.receive(c); }, 1);
  }

  private startTransfer(key: PageKey, remove: boolean) {
    const id = pageId(key);
    const refuse = this.refuseTimes.get(id) ?? 0;
    if (refuse > 0) {
      this.refuseTimes.set(id, refuse - 1);
      return this.reply(packet(0xa3, [...le32(0), ...le32(0), 0], 1));
    }
    const strokes = this.memory.get(id)?.strokes ?? [];
    if (!this.unlocked || !strokes.length) return this.reply(packet(0xa3, [...le32(0), ...le32(0), 0]));
    const groups: Stroke[][] = [];
    for (let i = 0; i < strokes.length; i += this.strokesPerPacket) groups.push(strokes.slice(i, i + this.strokesPerPacket));
    let total = 0;
    this.queue = groups.map((g, idx) => {
      const raw = g.flatMap((s) => this.encode(s, key.page));
      total += raw.length;
      const pos = groups.length === 1 ? 2 : idx === 0 ? 0 : idx === groups.length - 1 ? 2 : 1;
      return packet(0x24, [...le16(idx), 0, ...le16(raw.length), ...le16(0), pos, ...so(key.section, key.owner), ...le32(key.note), ...le16(g.length), ...raw], null);
    });
    if (remove) { this.deletedPages.push(key); this.memory.delete(id); }
    this.reply(packet(0xa3, [...le32(strokes.length), ...le32(total), 0]));
    this.sendNext();
  }

  private sendNext() {
    if (!this.queue.length) return;
    if (this.powerOffAfterPackets !== null && this.packetsSent >= this.powerOffAfterPackets) {
      this.queue = [];
      setTimeout(() => this.session?.linkClosed(), 1);
      return;
    }
    this.packetsSent++;
    this.reply(this.queue.shift()!);
  }

  /** Writes a live stroke (pen-down, page, dots, pen-up), like protocol 2.18. */
  writeLive(key: PageKey, s: Stroke) {
    const out: number[] = [];
    out.push(...packet(0x69, [1, ...le64(s.t), s.tip, ...le32(s.color)], null));
    out.push(...packet(0x6b, [2, ...so(key.section, key.owner), ...le32(key.note), ...le32(key.page)], null));
    for (let i = 0; i + 2 < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      out.push(...packet(0x6c, [3, 10, ...le16(s.pts[i + 2]), ...le16(Math.floor(x)), ...le16(Math.floor(y)), frac(x), frac(y), 0, 0, 0, 0], null));
    }
    out.push(...packet(0x6a, [4, ...le64(s.t + 500), ...new Array(10).fill(0)], null));
    this.reply(out);
  }

  shutdown() { this.reply(packet(0x62, [1], null)); }

  private encode(s: Stroke, page: number): number[] {
    const n = pointCount(s);
    const out = [...le32(page), ...le64(s.t - 7), ...le64(s.t + 400), s.tip, ...le32(s.color), ...le16(n)];
    for (let j = 0; j < n; j++) {
      const x = s.pts[j * 3], y = s.pts[j * 3 + 1], f = s.pts[j * 3 + 2];
      out.push(j === 0 ? 7 : 12, ...le16(f), ...le16(Math.floor(x)), ...le16(Math.floor(y)), frac(x), frac(y), 1, 2, 0, 0, 0, 0, 0);
    }
    return out;
  }
}

/** Fake but realistic strokes. */
export function makeStrokes(n: number, from: number, x = 20, y = 30): Stroke[] {
  return Array.from({ length: n }, (_, i) => {
    const pts: number[] = [];
    for (let j = 0; j < 8 + (i % 5); j++) pts.push(x + i * 3 + j * 0.4, y + (j % 3) * 0.25, 300 + j * 10);
    return { t: from + i * 2000, tip: 0, color: 0xff000000, pts: pts.map((v) => Math.round(v * 100) / 100) };
  });
}
