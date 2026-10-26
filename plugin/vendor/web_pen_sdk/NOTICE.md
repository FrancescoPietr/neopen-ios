# web_pen_sdk (vendored)

Source: npm `web_pen_sdk` 0.8.0 — https://github.com/NeoSmartpen/WEB-SDK2.0
Copyright NeoLAB Convergence Inc. — License: GPL-3.0-only.

Modifications made for this plugin:
- Removed `PenHelper.ts`, `NoteServer.ts` (Firebase), `PUIController.ts` (jQuery), `symbolBox.ts`, nproj files.
- `PenRequestV2.ts`: import PenController from "./PenController" instead of the package index.
- `PenClientParserV2.ts`: import from "../API/PUIStub" (stub) instead of PUIController.
- `zlib` is aliased at build time to `src/shims/zlib.ts` (fflate).
- Added `// @ts-nocheck` at the top of upstream files (they are not strict-mode clean).

- `PenCotroller/PenClientParserV2.ts`: `OFFLINE_DATA_SEND_START` riceve le informazioni del trasferimento (numero di tratti, byte); se `penController.abortOfflineTransfer` è vero, il trasferimento in corso viene interrotto rispondendo "fine" alla penna (per non riscaricare pagine invariate).
