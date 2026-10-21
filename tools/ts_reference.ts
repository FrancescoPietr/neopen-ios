// Fa leggere i vettori al kit ufficiale (quello del plugin) e scrive cosa ne ricava, nello stesso formato del test Swift.
import PenController from "/home/claude/neo-pen-obsidian/vendor/web_pen_sdk/PenCotroller/PenController";
import PenMessageType from "/home/claude/neo-pen-obsidian/vendor/web_pen_sdk/API/PenMessageType";
import { readFileSync, writeFileSync } from "fs";

const vectors = JSON.parse(readFileSync(process.argv[2], "utf8"));
const r2 = (n: number) => Math.round(n * 100) / 100;
const out: any = {};

(async () => {
  for (const v of vectors) {
    const ev: any[] = [];
    const c = new PenController();
    c.addWrite(() => {});
    let cur: any = null;
    const finish = () => {
      if (cur && cur.key.page >= 0 && cur.pts.length >= 3) ev.push({ live: `${cur.key.section}_${cur.key.owner}_${cur.key.note}_${cur.key.page}`, t: cur.t, pts: cur.pts.map(r2) });
      cur = null;
    };
    c.addCallback(
      (_c: any, dot: any) => {
        // stessa logica di PenConnection.onDot del plugin
        const p = dot.pageInfo ?? {};
        const key = { section: p.section, owner: p.owner, note: p.book ?? p.note, page: p.page };
        if (dot.dotType === 0) { finish(); cur = { key: { page: -1 }, t: dot.timeStamp, pts: [] }; return; }
        if (dot.dotType === 2) { finish(); return; }
        if (dot.dotType !== 1) return;
        if (!(dot.x >= 0 && dot.y >= 0) || key.page < 0) return;
        if (!cur) cur = { key, t: dot.timeStamp, pts: [] };
        cur.key = key;
        cur.pts.push(dot.x, dot.y, dot.f);
      },
      (_c: any, type: number, args: any) => {
        switch (type) {
          case PenMessageType.PEN_CONNECTION_SUCCESS: ev.push({ version: [c.info.DeviceName, c.info.FirmwareVersion, c.info.ProtocolVersion] }); break;
          case PenMessageType.PEN_SETTING_INFO: ev.push({ settings: [args.Locked, args.Battery, args.MaxForce, args.UsedMem] }); break;
          case PenMessageType.OFFLINE_DATA_NOTE_LIST: ev.push({ notes: args.map((n: any) => [n.Section, n.Owner, n.Note]) }); break;
          case PenMessageType.OFFLINE_DATA_PAGE_LIST: ev.push({ pages: [args.Section, args.Owner, args.Note, args.Pages] }); break;
          case PenMessageType.OFFLINE_DATA_SEND_START: ev.push({ start: [args.stroke, args.bytes] }); break;
          case PenMessageType.OFFLINE_DATA_SEND_FAILURE: ev.push({ failure: true }); break;
          case PenMessageType.EVENT_POWER_OFF: finish(); ev.push({ powerOff: true }); break;
          case PenMessageType.OFFLINE_DATA_SEND_SUCCESS:
            // stessa logica di PenConnection.onOfflineStrokes del plugin
            for (const s of args) {
              const d0 = s.Dots[0];
              const pts: number[] = [];
              for (const d of s.Dots) if (d.x >= 0 && d.y >= 0) pts.push(r2(d.x), r2(d.y), d.f);
              const p = d0.pageInfo;
              if (pts.length >= 3) ev.push({ offline: `${p.section}_${p.owner}_${p.book}_${p.page}`, t: d0.timeStamp, tip: d0.penTipType, color: d0.color, pts });
            }
            break;
        }
      }
    );
    for (const h of v.chunks) c.putData(Uint8Array.from(Buffer.from(h, "hex")) as any);
    await new Promise((r) => setTimeout(r, 300)); // lo zlib del kit è asincrono
    finish();
    out[v.name] = ev;
  }
  writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  console.log("ok", Object.keys(out).length);
})();
