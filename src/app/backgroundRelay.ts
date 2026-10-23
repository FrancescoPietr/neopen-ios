// Upload to the script through a native *background* URLSession: iOS carries the request out by itself even when the app
// is suspended (phone locked in a pocket), so pages leave the phone at once instead of waiting until the app is opened.
// If the app is killed before the answer is read, the page simply stays "to send" and goes again next time (the script
// replaces a page with the same id, so a repeat is harmless).
import { Directory, File, Paths } from "expo-file-system";
import NeoPenBle from "../../modules/neopen-ble";
import { RelayClient, RelayError } from "../core/relay";

const plain = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BackgroundRelayClient extends RelayClient {
  private counter = 0;

  protected override async post(body: string): Promise<void> {
    const dir = new Directory(Paths.document, "http");
    dir.create({ intermediates: true, idempotent: true });
    const id = `up-${Date.now()}-${++this.counter}`;
    const req = new File(dir, `${id}.req`);
    req.create({ overwrite: true });
    req.writeSync(body);
    const ok = NeoPenBle.startBackgroundPost(id, this.url, { "Content-Type": "text/plain;charset=utf-8" }, plain(req.uri));
    if (!ok) {
      req.delete();
      throw new RelayError("l'indirizzo dello script non è valido");
    }
    const done = new File(dir, `${id}.done`);
    const answer = new File(dir, `${id}.body`);
    const started = Date.now();
    // the answer is checked first: after a long sleep of the app the file is already there
    while (!done.exists) {
      if (Date.now() - started > 15 * 60_000) throw new RelayError("lo script non ha risposto");
      await sleep(400);
    }
    let info: { status: number; error?: string } = { status: 0 };
    let text = "";
    try {
      info = JSON.parse(done.textSync());
      text = answer.exists ? answer.textSync() : "";
    } finally {
      for (const f of [req, done, answer]) {
        try {
          if (f.exists) f.delete();
        } catch {
          /* leftovers are harmless */
        }
      }
    }
    if (info.error) throw new RelayError(info.error);
    if (!(info.status >= 200 && info.status < 300)) throw new RelayError(`lo script ha risposto ${info.status}`);
    RelayClient.check(text);
  }
}
