// Test: can a Claude call finish while the phone is locked? It goes through a native background URLSession, so iOS
// carries it out even with the app suspended; the result is read from files when the app wakes up or is opened.
import { Directory, File, Paths } from "expo-file-system";
import NeoPenBle from "../../modules/neopen-ble";

const dir = () => new Directory(Paths.document, "http");

const plain = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));

const clock = (ms: number) => new Date(ms).toLocaleTimeString("it-IT");

/** Starts the request and returns a message for the log. */
export function startClaudeTest(apiKey: string): string {
  dir().create({ intermediates: true, idempotent: true });
  const id = `prova-${Date.now()}`;
  const req = new File(dir(), `${id}.req`);
  req.create({ overwrite: true });
  req.writeSync(
    JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 1800,
      messages: [{ role: "user", content: "Scrivi in italiano un racconto di circa 1000 parole su una penna che ricorda tutto quello che ha scritto." }],
    })
  );
  const start = new File(dir(), `${id}.start`);
  start.create({ overwrite: true });
  start.writeSync(String(Date.now()));
  const ok = NeoPenBle.startBackgroundPost(
    id,
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    plain(req.uri)
  );
  return ok ? `Prova Claude avviata alle ${clock(Date.now())}: blocca il telefono e aspetta 2 minuti.` : "Prova Claude: richiesta non partita (indirizzo non valido).";
}

/** Reports finished tests (once each): call at startup and now and then. */
export function checkClaudeTests(log: (m: string) => void): void {
  try {
    const d = dir();
    if (!d.exists) return;
    for (const f of d.list()) {
      if (!(f instanceof File) || !f.name.endsWith(".done")) continue;
      const id = f.name.replace(/\.done$/, "");
      const seen = new File(d, `${id}.seen`);
      if (seen.exists) continue;
      const done = JSON.parse(f.textSync()) as { status: number; finished: number; error?: string };
      const start = new File(d, `${id}.start`);
      const began = start.exists ? Number(start.textSync()) : 0;
      const body = new File(d, `${id}.body`);
      let chars = 0;
      let detail = "";
      if (body.exists) {
        const text = body.textSync();
        try {
          const json = JSON.parse(text);
          chars = (json?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").length;
          if (json?.error?.message) detail = ` (${String(json.error.message).slice(0, 120)})`;
        } catch {
          detail = ` (risposta non leggibile: ${text.slice(0, 80)})`;
        }
      }
      const secs = began ? Math.round((done.finished - began) / 1000) : 0;
      log(
        `Prova Claude: stato ${done.status}${done.error ? ` errore «${done.error}»` : ""}, ${chars} caratteri${detail}. ` +
          `Partita alle ${began ? clock(began) : "?"}, finita alle ${clock(done.finished)} (${secs} s).`
      );
      seen.create({ overwrite: true });
      seen.writeSync("1");
    }
  } catch (e) {
    log(`Prova Claude: controllo non riuscito (${e instanceof Error ? e.message : String(e)}).`);
  }
}
