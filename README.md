# Neo Pen for iPhone

An iOS app that connects Francesco's **Neo Smartpen M1+** to his Obsidian vault, **in the background**:

1. Take the cap off.
2. iOS reconnects the pen and wakes the app.
3. The app downloads only what is missing from the pen's memory and receives strokes live while he writes.
4. Pages go to a Google Apps Script.
5. The **Neo Pen** Obsidian plugin on the PC picks them up (every minute) and transcribes them with Claude.

The app UI is in Italian (it's for Francesco). Code comments are mostly in Italian too; the structure below and the
tests should make it easy to follow. The Obsidian plugin lives in a separate repository. The project history is in
the file "Neo Pen - chat con Claude.md" (Italian) that Francesco shared.

## Open, sign, install

1. Open `NeoPen.xcodeproj` in Xcode 16 (iOS 17+).
2. Target **NeoPen** → *Signing & Capabilities*:
   - **Team**: your developer account;
   - **Bundle Identifier**: change it to your own (currently `com.neopen.app`).
   - The background mode is already in `Info.plist` (`UIBackgroundModes = bluetooth-central`).
3. Run on Francesco's iPhone (add it to your devices), or *Product → Archive → Distribute → TestFlight*.

The project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml`.
You can edit the project in Xcode directly, or edit `project.yml` and run `xcodegen generate`.

## First run on the iPhone

1. **Impostazioni** (Settings) → «Incolla dalla nota "Collegamento iPhone"» (paste from the note).
   - In Obsidian on the PC: Settings → Neo Pen → «Lettura dall'iPhone» → «Crea la nota». This creates a note with
     the script URL and the secret.
   - Copy it and tap paste. «Prova lo script» (test) should say everything is fine.
2. **Collega la penna** (connect the pen): cap off, tap the button. Only needed once.
3. From then on the app doesn't need to be opened. Leaving it in the background is fine, but it must **not be
   force-quit from the app switcher**: iOS won't relaunch a force-quit app until it is opened again.

## How it works

```
NeoPenKit/        pure Swift core (no UIKit/CoreBluetooth) — builds and tests on Linux too
  PenProtocol     Neo pen protocol v2 (framing, escaping, requests, offline + live stroke parsing)
  Inflate         zlib/DEFLATE decoder (the pen sends offline pages compressed)
  PenSession      connection: version → settings → password → clock → live mode → offline memory sync
  PageStore       page archive on the phone (one JSON per page, Application Support/pages)
  Relay/Uploader  upload to the Google script, one page per request, with retries
App/
  BLEManager      CoreBluetooth: state restoration + pending connect to the remembered pen
  AppModel        glue; log at Documents/registro.txt (shareable from the app)
  ContentView, SettingsView
```

The protocol is a port of NeoLAB's official **web** SDK (`web_pen_sdk`, TypeScript). The Obsidian plugin uses that
SDK with this exact pen. NeoLAB's iOS SDK is Objective-C, last updated in 2020 for Xcode 10, so it wasn't used.

### Background behaviour

- After the first pairing the pen's identifier is saved.
  - The app calls `connect()` on it; that request **never times out**.
  - When the pen powers on (cap off), iOS connects it and wakes the app.
- `CBCentralManagerOptionRestoreIdentifierKey`: if iOS terminated the app for memory, it relaunches it in the
  background (`willRestoreState`). The central manager must be created in `didFinishLaunching`; `AppDelegate`
  does that via `AppModel.shared`.
- On `didDisconnectPeripheral` (pen off) the app immediately calls `connect()` again for next time.
- Download and upload run inside `beginBackgroundTask`. In live mode every pen notification wakes the app.

### Syncing

- **Order:** the app reads the list of notebooks and pages. Pages never seen before go first, then from the last
  page down, so the page being written arrives first.
- **Duplicates and resume:** every stroke is identified by its pen-down time (`t`), so duplicates are dropped. If
  the pen goes off mid-transfer, the next connection simply resumes.
- **Never abort an offline transfer midway.** With the Bluefy web prototype, after an abort the pen stopped
  answering later requests. The «Salta le pagine invariate» option (skip unchanged pages) does abort; it is
  experimental and off by default.
- **Empty reads** are retried twice and never uploaded.
- **Live mode** (on by default): the pen does **not** store strokes it sends live.
  - The phone becomes the archive: `PageStore` plus the copy on the Google script.
  - The PC plugin (v0.13.1+) merges the iPhone copy back when it re-reads a page from the pen.
- **The pen accepts one connection at a time.** If Obsidian on the PC holds it, the iPhone waits, and vice versa.

### Upload format

POST `text/plain` (no CORS preflight) of `{"secret", "relay": {"action": "put", "pages": [{"id", "count", "strokes"}]}}`:
- `id` = `section_owner_note_page`, e.g. `3_27_746_9`;
- `count` = number of strokes in the page;
- `strokes` = `[{t, tip, color, pts: [x, y, force, …]}]`, coordinates rounded to 2 decimals.

## Tests

```
cd NeoPenKit && swift test
```

- **ParserParityTests:** the packets in `tools/vectors.json` must parse exactly like NeoLAB's official SDK does
  (reference output in `tools/expected.json`). The packets cover handshake, lists, offline pages with every
  compression mode, and live strokes, split randomly like BLE notifications.
  - Vectors are generated by `tools/make_vectors.py`.
  - The reference comes from `tools/ts_reference.ts`, which runs the SDK from the plugin repository.
- **RequestParityTests:** the commands sent to the pen are byte-identical to the official SDK's.
- **SessionTests:** a simulated pen (`FakePen`) with:
  - offline memory and per-packet acks;
  - power-off mid-transfer and resume;
  - live strokes, with no duplicates against offline memory;
  - password, retried empty reads, delete-after-download, a pen that stops answering.
- **UploaderTests:**
  - upload once per change;
  - failures stay pending;
  - strokes arriving during an upload stay pending;
  - the exact request body;
  - script error messages.

GitHub Actions (`.github/workflows/build.yml`) runs the tests and builds the app for the simulator on every push.

## To verify on a real phone

1. **First connection:** the pen answers and its memory downloads. The log shows «Penna pronta: NWP-F51…» and
   «Pagina 746/9: N tratti nuovi».
2. **Wake from off:** app in the background, phone locked, take the cap off. The pen should connect by itself
   within seconds; the log shows «Penna accesa: collegata.».
3. **Live:** while writing, «Da inviare al PC» goes up and back to 0. The page shows up in Obsidian on the PC
   within a minute.
4. **Resume:** cap the pen in the middle of a download. When it comes back on, the download resumes.
5. **Phone reboot:** unknown whether iOS relaunches the app by itself after a reboot, or whether it must be opened
   once.
6. **Pen held by the PC:** while Obsidian on the PC has the pen, the iPhone should wait without errors piling up.

The log can be shared from the app (Registro → Condividi). It's the most useful thing to send when something goes
wrong.

## Later

Customizable actions (Francesco wants to design them later), notifications, notebook selection, widget.
