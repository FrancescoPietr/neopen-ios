# Neo Pen for iPhone (Expo / React Native)

An iOS app that connects Francesco's **Neo Smartpen M1+** to his Obsidian vault, **in the background**:

1. Take the cap off.
2. iOS reconnects the pen and wakes the app.
3. The app downloads only what is missing from the pen's memory and receives strokes live while he writes.
4. Pages go to a Google Apps Script.
5. The **Neo Pen** Obsidian plugin on the PC picks them up (every minute) and transcribes them with Claude.

The UI is in Italian (the app is for Francesco); code and comments are in English. The Obsidian plugin lives in a
separate repository. The project history is in «Neo Pen - chat con Claude.md» (Italian), which Francesco shared.
A first, native Swift version of this app is in the git history (commit `de30044`).

## Stack

- **Expo SDK 58**, React Native 0.88, TypeScript.
- **No Expo Go**: the app has native code, a local Expo module for Bluetooth. Use an EAS **development build**
  to develop, and a **preview** (internal distribution) build for Francesco's phone. No Xcode needed: EAS builds
  in the cloud.

```
App.tsx, index.ts          entry; the model starts in index.ts before any screen (background relaunch)
src/core/                  plain TypeScript, no React Native: testable in Node
  protocol.ts              Neo pen protocol v2 (framing, escaping, requests, offline + live stroke parsing)
  session.ts               connection: version → settings → password → clock → live mode → offline memory sync
  store.ts                 page archive (one JSON per page)
  relay.ts, uploader.ts    upload to the Google script, one page per request, with retries
src/app/                   glue: model.ts (native module ↔ session ↔ uploads), files.ts (expo-file-system)
src/ui/screens.tsx         home, settings, log
modules/neopen-ble/        local Expo module (Swift)
  ios/PenBluetooth.swift   CoreBluetooth: state restoration + pending connect to the remembered pen
  ios/NeoPenAppDelegate.swift  creates the Bluetooth central at launch (AppDelegate subscriber)
  ios/NeoPenBleModule.swift    JS API: searchPen, forgetPen, send(base64), events, background tasks
test/                      Node tests (node:test via tsx)
tools/                     reference packets from NeoLAB's official SDK
```

The protocol is a port of NeoLAB's official **web** SDK (`web_pen_sdk`, TypeScript). The Obsidian plugin uses that
SDK with this exact pen. NeoLAB's iOS SDK is Objective-C, last updated in 2020, so it wasn't used. Neither was
`react-native-ble-plx`: its native module uses the legacy architecture, and we need full control over state
restoration anyway.

## Develop

```
npm install
npm run typecheck
npm test                                          # 17 tests, ~30 s
npx eas-cli@latest login
npx eas-cli@latest device:create                  # register Francesco's iPhone (opens a link to install a profile)
npx eas-cli@latest build --profile development --platform ios   # dev client; then: npx expo start --dev-client
npx eas-cli@latest build --profile preview --platform ios       # standalone build for daily use (install via QR/link)
```

- Change `ios.bundleIdentifier` in `app.json` (currently `com.neopen.app`) to one under your Apple account; EAS
  handles certificates and profiles.
- `UIBackgroundModes = bluetooth-central` and the Bluetooth usage text are in `app.json`.
- JS-only changes reload in the dev client. Changes under `modules/` need a new build.

## First run on the iPhone

1. **Impostazioni** (Settings) → «Incolla dalla nota "Collegamento iPhone"» (paste from the note).
   - In Obsidian on the PC: Settings → Neo Pen → «Lettura dall'iPhone» → «Crea la nota». This creates a note with
     the script URL and the secret, synced to the phone by Obsidian Sync.
   - Copy it and tap paste. «Prova lo script» (test) should say everything is fine.
2. **Collega la penna** (connect the pen): cap off, tap the button. Only needed once.
3. From then on the app doesn't need to be opened. Leaving it in the background is fine, but it must **not be
   force-quit from the app switcher**: iOS won't relaunch a force-quit app until it is opened again.

## Background behaviour

- After the first pairing the pen's identifier is saved.
  - Native code calls `connect()` on it; that request **never times out**.
  - When the pen powers on (cap off), iOS connects it and wakes the app.
- **State restoration** (`CBCentralManagerOptionRestoreIdentifierKey`): if iOS terminated the app for memory, it
  relaunches it in the background.
  - The central manager is created in `didFinishLaunching` by the AppDelegate subscriber, before JavaScript.
  - Events (data, state, logs) are **queued natively** until JS subscribes, so nothing is lost while the JS bundle
    loads.
- `index.ts` starts the model at bundle load, not in a component.
- On disconnect (pen off), native code calls `connect()` again right away for next time.
- Download and uploads run inside iOS background tasks (`beginBackgroundTask`, exposed by the module). In live mode
  every pen notification wakes the app.

## Sync rules

- **Order:** the app reads the list of notebooks and pages. Pages never seen before go first, then from the last
  page down.
- **Duplicates and resume:** every stroke is identified by its pen-down time (`t`), so duplicates are dropped. If
  the pen goes off mid-transfer, the next connection resumes.
- **Never abort an offline transfer midway.** With the Bluefy web prototype the pen stopped answering after an
  abort. «Salta le pagine invariate» (skip unchanged) does abort; it is experimental and off by default.
- **Empty reads** are retried twice and never uploaded.
- **Live mode** (default): the pen does **not** store strokes it sends live.
  - The phone becomes the archive: the pages in `Documents/pages` plus the copy on the Google script.
  - The PC plugin (v0.13.1+) merges the iPhone copy back when it re-reads a page from the pen.
- **The pen accepts one connection at a time.** If Obsidian on the PC holds it, the iPhone waits, and vice versa.

Upload: POST `text/plain` of `{"secret", "relay": {"action": "put", "pages": [{"id", "count", "strokes"}]}}`:
- `id` = `section_owner_note_page`, e.g. `3_27_746_9`;
- `count` = number of strokes in the page;
- `strokes` = `[{t, tip, color, pts: [x, y, force, …]}]`, coordinates rounded to 2 decimals.

## Tests

- **`test/parity.test.ts`:**
  - the packets in `tools/vectors.json` parse exactly like NeoLAB's official SDK (`tools/expected.json`). They cover
    handshake, lists, offline pages with every compression mode, and live strokes split like BLE notifications;
  - requests are byte-identical to the SDK's;
  - base64 round-trips.
- **`test/session.test.ts`:** a simulated pen (`test/fakePen.ts`) with:
  - offline memory and per-packet acks;
  - power-off mid-transfer and resume;
  - live strokes, with no duplicates against offline memory;
  - password, retried empty reads, delete-after-download, skip-unchanged, a pen that stops answering.
- **`test/uploader.test.ts`:** upload once per change, failures stay pending, strokes arriving mid-upload stay
  pending, exact request body, script errors.

GitHub Actions (`.github/workflows/build.yml`) runs on every push:
1. typecheck and tests;
2. `expo prebuild` and `pod install`;
3. an `xcodebuild` of the whole app for the simulator.

## To verify on a real phone

1. **First connection:** the pen answers and its memory downloads. The log shows «Penna pronta: NWP-F51…» and
   «Pagina 746/9: N tratti nuovi».
2. **Wake from off:** app in the background, phone locked, take the cap off. The pen should connect by itself
   within seconds; the log shows «Penna accesa: collegata.».
3. **Live:** while writing, «Da inviare al PC» goes up and back to 0. The page shows up in Obsidian on the PC
   within a minute.
4. **Resume:** cap the pen in the middle of a download. When it comes back on, the download resumes.
5. **Relaunch by iOS:** check that the log shows «App avviata da iOS per la penna» and that pages still arrive.
6. **Phone reboot:** unknown whether iOS relaunches the app by itself after a reboot, or whether it must be opened
   once.
7. **Pen held by the PC:** while Obsidian on the PC has the pen, the iPhone should wait without errors piling up.

The log can be shared from the app (Registro → Condividi il registro).

## Later

Customizable actions (Francesco wants to design them later), notifications, notebook selection.
