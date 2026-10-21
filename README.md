# Neo Pen per iPhone

App iOS che collega la **Neo Smartpen M1+** di Francesco al suo vault di Obsidian, **in background**:
togli il tappo → iOS ricollega la penna e risveglia l'app → l'app scarica dalla memoria della penna
solo quello che manca e riceve i tratti in tempo reale mentre scrivi → le pagine vanno allo script Google →
il plugin **Neo Pen** di Obsidian sul PC le preleva (ogni minuto) e le trascrive con Claude.

Il plugin di Obsidian è in un altro repository; la storia del progetto è nel file
«Neo Pen - chat con Claude.md» che Francesco ti ha mandato.

## Aprire, firmare, installare

1. Apri `NeoPen.xcodeproj` con Xcode 16 (iOS 17 o successivo).
2. Target **NeoPen** → *Signing & Capabilities*:
   - **Team**: il tuo account sviluppatore;
   - **Bundle Identifier**: cambialo in uno tuo (ora è `com.neopen.app`).
   - La capability *Background Modes → Uses Bluetooth LE accessories* è già nel `Info.plist`
     (`UIBackgroundModes = bluetooth-central`).
3. Collega l'iPhone di Francesco (o aggiungilo ai tuoi dispositivi) e premi Run.
   Per lasciarglielo senza cavo: *Product → Archive → Distribute → TestFlight*.

Il progetto è generato con [XcodeGen](https://github.com/yonaskolb/XcodeGen) da `project.yml`.
Se aggiungi file o cambi impostazioni puoi modificare direttamente il progetto in Xcode,
oppure `project.yml` e poi `xcodegen generate`.

## Primo avvio sull'iPhone

1. **Impostazioni** dell'app → «Incolla dalla nota "Collegamento iPhone"».
   - In Obsidian sul PC: Impostazioni → Neo Pen → «Lettura dall'iPhone» → «Crea la nota».
   - Copia la nota e incollala: indirizzo dello script e chiave.
   - «Prova lo script» deve dire «tutto a posto».
2. **Collega la penna**: togli il tappo e tocca «Collega la penna». Serve solo la prima volta.
3. Da lì in poi non serve aprire l'app. Va bene lasciarla in background, ma **non va chiusa a mano dal
   multitasking**: chiusa così, iOS non la risveglia più finché non la riapri.

## Come funziona

```
NeoPenKit/        nucleo in Swift puro (niente UIKit/CoreBluetooth): si prova anche su Linux
  PenProtocol     protocollo 2 della penna (pacchetti, escape, comandi, tratti offline e in tempo reale)
  Inflate         decompressore zlib (la penna manda le pagine compresse)
  PenSession      collegamento: presentazione → impostazioni → password → orologio → tempo reale → memoria
  PageStore       archivio delle pagine sul telefono (un JSON per pagina, Application Support/pages)
  Relay/Uploader  invio allo script Google, una pagina per richiesta, con nuovi tentativi
App/
  BLEManager      CoreBluetooth: restore identifier, connect "in attesa" alla penna ricordata
  AppModel        tiene insieme tutto; registro in Documents/registro.txt (condivisibile dall'app)
  ContentView, SettingsView
```

### In background

- Dopo il primo abbinamento l'identificatore della penna è salvato.
  - Si chiama `connect()` su quella penna: una richiesta che **non scade mai**.
  - Quando la penna si accende (tappo tolto), iOS la collega e risveglia l'app.
- `CBCentralManagerOptionRestoreIdentifierKey`: se iOS ha terminato l'app per memoria, la rilancia in
  background (`willRestoreState`). Il central manager va creato subito, in `didFinishLaunching`: lo fa
  `AppDelegate`.
- Quando la penna si spegne (`didDisconnectPeripheral`), si richiama subito `connect()` per la volta dopo.
- Lo scaricamento e l'invio stanno dentro `beginBackgroundTask`. In tempo reale ogni notifica della penna
  risveglia l'app.

### Lo scaricamento

- **Memoria:** si legge l'elenco di quaderni e pagine. Si scaricano prima le pagine mai viste, poi dall'ultima
  in giù.
- **Doppioni:** ogni tratto si riconosce dall'ora del pen-down (`t`), quindi i doppioni si scartano. Se la penna
  si spegne a metà, al giro dopo si riprende tutto.
- **Mai interrompere un invio offline:** non si fa "abort" a metà. Con Bluefy, dopo un abort la penna smetteva
  di rispondere. L'opzione «Salta le pagine invariate» lo fa, ed è sperimentale: provatela guardando il registro.
- **Letture vuote:** si riprovano 2 volte e non si inviano mai.
- **Tempo reale** (attivo di base): la penna **non salva** in memoria i tratti mandati in tempo reale.
  - L'archivio vero diventa il telefono: le pagine in `PageStore` e la copia sullo script Google.
  - Il plugin sul PC unisce la copia dall'iPhone anche quando rilegge la pagina dalla penna (dalla versione
    0.13.1).
- **La penna accetta un solo collegamento.** Se Obsidian sul PC la sta usando, l'iPhone aspetta, e viceversa.

### Formato verso lo script

POST `text/plain` con `{"secret", "relay": {"action": "put", "pages": [{"id", "count", "strokes"}]}}`:
- `id` = `sezione_proprietario_quaderno_pagina`, per esempio `3_27_746_9`;
- `count` = numero di tratti della pagina;
- `strokes` = `[{t, tip, color, pts: [x, y, pressione, …]}]` con le coordinate arrotondate a 2 decimali.

## Prove

```
cd NeoPenKit && swift test
```

- **ParserParityTests:** i pacchetti di `tools/vectors.json` danno gli stessi risultati del kit ufficiale Neo
  (quello che il plugin usa davvero con questa penna; riferimento in `tools/expected.json`). I pacchetti coprono
  presentazione, elenchi, pagine compresse in tutti i modi e tempo reale.
  - Vettori: `tools/make_vectors.py`. Riferimento: `tools/ts_reference.ts`, che gira con il kit del repository
    del plugin.
- **RequestParityTests:** i comandi verso la penna sono identici byte per byte a quelli del kit ufficiale.
- **SessionTests:** una penna simulata (`FakePen`) con:
  - memoria e conferme pacchetto per pacchetto;
  - spegnimento a metà e ripresa;
  - tempo reale, senza doppioni rispetto alla memoria;
  - password, letture vuote ritentate, svuotamento della memoria, penna che non risponde.

GitHub Actions (`.github/workflows/build.yml`) esegue le prove e compila l'app per il simulatore a ogni push.

## Da verificare sul telefono vero

1. **Primo collegamento:** la penna risponde e si scarica la memoria. Il registro mostra
   «Penna pronta: NWP-F51…» e «Pagina 746/9: N tratti nuovi».
2. **Risveglio da spenta:** app in background, telefono bloccato, si toglie il tappo. La penna si deve
   collegare da sola entro pochi secondi; nel registro compare «Penna accesa: collegata.».
3. **Tempo reale:** scrivendo, «Da inviare al PC» sale e poi torna a 0. Sul PC la pagina arriva in Obsidian
   entro un minuto.
4. **Ripresa:** si chiude la penna a metà scaricamento. Alla riaccensione deve riprendere.
5. **Telefono riavviato:** non sappiamo se iOS rilancia l'app da solo dopo un riavvio o se va aperta una volta.
6. **Penna collegata al PC:** se Obsidian sul PC ha la penna, l'iPhone deve aspettare senza errori ripetuti.

Il registro si condivide dall'app (Registro → Condividi): è la cosa più utile da mandare quando qualcosa non va.

## Idee per dopo

Azioni personalizzabili (Francesco le vuole progettare più avanti), notifiche, scelta del quaderno, widget.
