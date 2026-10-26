# Neo Pen per Obsidian · v0.12.21

Collega la Neo Smartpen M1+ direttamente al tuo vault Obsidian, senza Neo Studio.

## Cosa fa questa versione

- **Diagnostica Bluetooth (fase 0).** Verifica se Obsidian sul tuo PC può usare il Bluetooth e prova a trovare la penna.
- **La penna è l'archivio.** La penna salva in memoria tutto quello che scrivi (lo fa solo quando NON è collegata). Il plugin si collega solo per leggere: quando accendi la penna (tappo aperto) la trova da solo entro una ventina di secondi, legge le pagine cambiate, trascrive e si scollega. Mentre la penna resta accesa ripete la lettura ogni 5 minuti (regolabile). C'è sempre anche il pulsante **Sincronizza ora**.
- **Solo le pagine cambiate.** La penna dichiara quanti tratti ha ogni pagina: quelle invariate non vengono riscaricate.
- **Niente copie nel plugin.** Il plugin non salva i tratti: ricorda solo, per ogni pagina, fin dove l'ha già trascritta. Su disco restano le note e i disegni (`NeoPen/_pagine/<id>.svg`).
- **Memoria della penna.** Una finestra (pulsante nel pannello, comando o impostazioni) mostra le pagine salvate nella penna e quanta memoria è usata; da lì scegli cosa **recuperare** in Obsidian (ricrea e ritrascrive la nota) e cosa **cancellare** dalla penna (con conferma). La penna non cancella mai nulla da sola.
- **Diagnostica Bluetooth.** Verifica se Obsidian sul tuo PC può usare il Bluetooth.

- **Trascrizione.** Con Claude, dopo ogni sincronizzazione: una chiamata per ogni pagina con tratti nuovi. Il testo nuovo viene aggiunto alla sezione "Testo" della nota di quella pagina. Le righe che iniziano con un quadratino disegnato diventano `- [ ]` (o `- [x]` se spuntate), con la data nel formato del plugin Tasks (`📅 2026-10-23`). Il plugin modifica solo il testo tra `<!-- neopen:testo:ID -->` e `<!-- /neopen:testo:ID -->` (un blocco per pagina): tutto il resto della nota è tuo.

- **Tag, template e continuazioni (fase 4).**
  - Un `#tag` scritto **da solo sulla prima riga** della pagina decide dove va la pagina, secondo le regole in Impostazioni → Neo Pen → "Tag e tipi di nota". Le regole si aggiungono e modificano quando vuoi.
  - Regola di partenza: `#task` / `#tasks` → le righe finiscono nella **nota del giorno** (quella del plugin "Note del giorno" di Obsidian), sotto `## Task`. Un orario scritto ("alle 15") diventa `- [ ] 15:00 …`, una data diventa `📅 2026-10-23`.
  - **Template con lo stesso nome del tag (anche Templater):** se per un tag non c'è una regola, il plugin cerca nella cartella dei template (quella di Templater o del plugin "Modelli") un template con lo stesso nome: `#riunione` → `Riunione.md`, `#lezioneuniversita` → `Lezione Università.md` (maiuscole, spazi e accenti non contano). I comandi di Templater (`<% tp.file.title %>`, `<% tp.date.now() %>`…) vengono eseguiti una volta sola, anche se in Templater hai attivo "Trigger Templater on new file creation". Nel template scrivi `{{testo}}` dove vuoi la trascrizione (altrimenti va in fondo sotto "## Testo") e `{{disegno}}` dove vuoi l'immagine. Si può spegnere in Impostazioni → "Template con lo stesso nome del tag".
  - Regole "Nota da template": cartella, titolo (`{{date}} {{titolo}}`) e un template tuo (basta il nome, es. `Riunione`). Nel template puoi usare `{{title}}`, `{{date}}`, `{{date:DD/MM/YYYY}}`, `{{time}}`, `{{tag}}`, `{{quaderno}}`, `{{pagina}}`, `{{disegno}}` e `{{testo}}` (dove va la trascrizione; se manca, va in fondo sotto "## Testo"). Se il template non esiste ancora, si usa quello di base.
  - **Doppia sottolineatura = titolo e nota nuova.** Una riga sottolineata due volte è un titolo e apre una nota nuova: in cima alla pagina dà il nome alla nota della pagina; a metà pagina, da lì in giù il testo va in una nota nuova con quel titolo (il testo prima resta nella nota precedente). Un `#tag` che ha un template, scritto **accanto** al titolo (prima o dopo, sulla stessa riga) o **subito sopra** (anche se è stretto contro la fine della nota precedente), è sempre il template di quel titolo: non finisce mai nel testo né tra i tag della nota sopra. Se lo aggiungi **dopo** a un titolo già trascritto, la nota di quel titolo (se era stata creata senza template) viene ricreata col template, con tutto il suo testo; la vecchia va in `NeoPen/_cestino`. Vale anche se la doppia linea la tracci dopo. Eccezione: su una pagina che continua un'altra nota (freccia «→ N» sulla pagina prima) la freccia vince: il titolo in cima resta nella nota, in grassetto (i titoli a metà pagina aprono comunque una nota nuova).
  - **Più titoli e più frecce sulla stessa pagina:** ogni freccia continua la parte della pagina in cui l'hai disegnata (quella sotto il titolo più vicino sopra la freccia). Una freccia prima di ogni titolo continua la prima parte.
  - **Solo una parte della pagina nella nota del giorno:** scrivi `#task` accanto (o subito sopra) a un titolo con la doppia sottolineatura a metà pagina: quella parte va nella nota del giorno (che resta col nome della data; il titolo diventa un'etichetta in grassetto sopra i suoi task). Il titolo con la doppia linea successivo apre un'altra nota.
  - **Risposte con la freccia:** una freccia che parte da una riga (anche dalla casella di un task) e arriva a una scritta più sotto o accanto: quella scritta è una risposta a quella riga. Va sotto la riga come sotto-punto `↳ …` (non è un task) e, se la riga è un task, finisce anche nelle note dell'evento o dell'attività.
  - **Parole frequenti e parole da non usare** (Impostazioni → Neo Pen): le prime aiutano a leggere il corsivo; le seconde sono letture sbagliate tipiche della tua grafia (es. «violeo» per «video»): Claude non le usa e, se compaiono, il plugin le sostituisce con la parola frequente più simile.
  - **Una sola sottolineatura = grassetto** (`**testo**`), non un titolo. Sottolineatura e cancellatura si distinguono anche dalla posizione della linea: sotto le lettere è una sottolineatura (non cancella mai), a metà delle lettere è una cancellatura. Le **cancellature** (linee dritte, oblique, tratteggi su più righe o scarabocchi) vengono riconosciute dai tratti: le parole cancellate (e le loro caselle) vengono **tolte dall'immagine** prima di mandarla a Claude, così non possono essere trascritte, anche con «Ritrascrivi da capo» o quando recuperi una pagina dalla memoria della penna. Se cancelli testo già trascritto, la linea arriva a Claude in rosso e quel testo viene tolto dalla nota.
  - **Titolo o tag scritti dopo:** se la nota è ancora quella di base (creata in automatico, con una sola pagina), una doppia sottolineatura aggiunta dopo in cima la rinomina col titolo, e un `#tag` aggiunto dopo in cima la sposta nella nota prevista dalla regola (la vecchia va in `NeoPen/_cestino`).
  - Il **tag della pagina** (quello in cima) non compare mai nel testo: diventa un tag della nota, anche se non c'è ancora una regola per lui. Lo stesso vale per i tag che hanno una regola.
  - Gli **altri #tag** scritti ovunque nella pagina restano nel testo e vengono aggiunti anche ai tag della nota.
  - Una **freccia verso un numero** (`→ 7`) fa continuare la nota sulla pagina 7: il testo della 7 viene subito dopo quello della pagina precedente, senza intestazioni, come un testo unico. Anche una frase spezzata tra le due pagine resta sulla stessa riga. Funziona a catena (6 → 9 → 12), e se aggiungi testo a una pagina precedente resta prima di quella successiva.
  - La freccia funziona anche se la disegni **dopo** aver scritto sulla pagina nuova: le due note di base vengono unite (quella della pagina nuova va in `NeoPen/_cestino`). Le note da template o rinominate non vengono unite.
  - **Disegno della pagina:** in ogni nota c'è una miniatura del disegno (anche se il template non ha `{{disegno}}`: va subito prima del testo); un clic la apre con tutta la pagina visibile; clic su un punto per ingrandire lì (clic di nuovo per tornare intera), rotellina o pizzico per lo zoom, trascina per spostarti. In ogni nota resta una sola miniatura per disegno. Se in una nota manca, comando «Rimetti il disegno della pagina in questa nota».
  - Una nota di più pagine ha **un'unica immagine**: le pagine sono impilate nell'ordine, ognuna con i suoi spazi reali, separate da una linea tratteggiata leggera.
  - **Marcatori:** nel file ogni pagina è racchiusa tra `<!-- neopen:testo:ID -->` e `<!-- /neopen:testo:ID -->` (servono al plugin). Nell'editor sono nascosti; con "Mostra i marcatori delle pagine" (impostazioni) li vedi, insieme a un'etichetta "Pagina N".
  - Se rinomini o sposti una nota, il plugin se ne accorge e continua a scriverci.

- **Calendario (Google).** Nelle pagine #task / #tasks i task scritti a mano con un orario («alle 15», «14:00 - 14:30», «dalle 9 alle 11») diventano eventi di Google Calendar (quindi anche in Fantastical), con il link alla nota; quelli senza orario diventano attività di **Todoist** o di **Google Tasks**, a scelta (con scadenza se hai scritto una data; nella nota del giorno, il giorno della nota). Per Todoist basta il token API (Todoist → Impostazioni → Integrazioni → Sviluppatore). Gli orari usano in automatico il fuso di questo dispositivo, come il telefono; in Impostazioni → «Fuso orario degli eventi» puoi scegliere quello di Google Calendar o uno a mano (es. Europe/Rome). Spuntati con la penna o in Obsidian: l'evento prende una ✓ e diventa grigio, l'attività risulta completata. Cancellati dalla nota: spariscono anche da Google. Il collegamento passa da un piccolo Google Apps Script tuo: Impostazioni → Neo Pen → Calendario → «Copia lo script», incollalo in script.google.com, aggiungi il servizio «Google Tasks API» (Servizi → +), pubblicalo come app web e incolla l'URL. Per ogni regola di tag puoi scegliere se i suoi task vanno nel calendario.
- **Task su più righe.** Se un task continua a capo, lasciando vuoto lo spazio della casella a sinistra, resta un task solo.
- **Correzioni.** Se cancelli delle parole e riscrivi sopra o accanto (es. «alle ~~15:00~~ 16:00»), nella nota resta solo la versione corretta, anche su righe già trascritte; il calendario si aggiorna di conseguenza.

Su iPhone il plugin è passivo (le note arrivano con Obsidian Sync; trascrizione, calendario e impostazioni li gestisce il PC). Lettura dall'iPhone (Bluefy): la pagina `index.html` in Bluefy legge la penna e lascia le pagine nello script Google; il PC le prende ogni 2 minuti e le trascrive (Impostazioni → Calendario → Lettura dall'iPhone).

## Dove sono i tuoi dati

- **Nella penna:** tutti i tratti. Restano lì finché non li cancelli tu dalla finestra **Memoria della penna**. Se la memoria supera l'80% il plugin te lo segnala.
- **Nel vault:** le note, i disegni in `NeoPen/_pagine` e, nelle impostazioni del plugin, per ogni pagina quanti tratti aveva e fin dove è trascritta.
- **Cartella `NeoPen/_dati`** (versioni fino alla 0.5): non serve più. Alla prima apertura il plugin ne legge solo lo stato delle trascrizioni; poi puoi cancellarla. Attenzione: contiene anche pagine scritte con la penna collegata, che non sono nella penna.
- Mentre la penna è collegata (per pochi secondi durante la sincronizzazione, o con la finestra Memoria aperta) quello che scrivi potrebbe non restare nella penna: il plugin lo tiene finché Obsidian è aperto e lo trascrive comunque.
- Cancellare una nota **non** cancella la pagina dalla penna, e il plugin **non** la ricrea da solo: la recuperi dalla finestra Memoria della penna.
- Le note che il plugin sostituisce (unione di pagine, spostamento per un tag) finiscono in `NeoPen/_cestino`.

## Trascrizione: come attivarla

1. Crea una chiave API su https://platform.claude.com (API Keys) e aggiungi un po' di credito.
2. Impostazioni → Neo Pen → **Chiave API di Claude**.
3. Scrivi: alla sincronizzazione successiva (quando accendi la penna, ogni 5 minuti mentre è accesa, o con «Sincronizza ora») il testo compare nella nota.

**Costi.** Ogni chiamata ha una parte fissa (istruzioni e immagine), quindi la cosa che conta di più è *quante* chiamate si fanno: si trascrive una volta per pagina a ogni sincronizzazione, solo se ci sono tratti nuovi (con un intervallo più lungo, meno chiamate). Inoltre le istruzioni sono corte e in cache, la risposta è compatta e l'immagine delle aggiunte piccole è più leggera. Il costo stimato di ogni chiamata compare nel registro, il totale del mese nelle impostazioni. Per spendere ancora meno: alza l'intervallo di sincronizzazione.

Comandi utili (Ctrl+P): **Trascrivi il testo nuovo della pagina corrente** e **Ritrascrivi da capo la pagina corrente** (sostituisce tutto il blocco trascritto). Se la nota contiene più pagine, ti chiede quale (o tutte). La "pagina corrente" è la nota Neo Pen aperta, oppure l'ultima pagina letta (se serve, il plugin la rilegge dalla penna, che deve essere accesa).

## Installazione sul PC Windows

1. Nel tuo vault apri la cartella `.obsidian/plugins/` (è nascosta: in Esplora file attiva "Elementi nascosti").
2. Crea la cartella `neo-pen` e copiaci dentro **`main.js`, `manifest.json`, `styles.css`**.
3. In Obsidian: Impostazioni → Plugin della community → disattiva la modalità con restrizioni se richiesto → ricarica l'elenco → attiva **Neo Pen**.

## Aggiornare il plugin

Sostituisci solo `main.js`, `manifest.json` e `styles.css`. **Non cancellare `data.json`**: contiene le impostazioni, compresa la chiave API.

## Primo test

1. **Su iPhone chiudi Neo Studio 2 o spegni il Bluetooth**, altrimenti la penna si collega al telefono.
2. Apri il pannello (icona della penna a sinistra) e premi **Sincronizza ora** con la penna accesa: la prima volta serve a farle "conoscere" la penna.
3. Chiudi il tappo, aspetta un po', riaprilo: entro una ventina di secondi nel registro compare «Penna accesa: sincronizzo…».
4. Scrivi qualcosa con la penna e premi di nuovo **Sincronizza ora** (o aspetta la sincronizzazione automatica).
5. Se qualcosa non va, **Diagnostica Bluetooth** → **Copia risultato** e mandamelo.

### Se la diagnostica fallisce

| Messaggio | Significato |
|---|---|
| `navigator.bluetooth: assente` | Questa versione di Obsidian non espone Web Bluetooth: si passa al piano B, un piccolo programma di supporto. |
| `Adattatore Bluetooth disponibile: no` | Il Bluetooth del PC è spento o il PC non ce l'ha (serve Bluetooth 4.0+). |
| `Ricerca fallita: … cancelled` | Obsidian ha annullato la scelta del dispositivo: mandami il registro e lo sistemiamo. |
| `Nessuna penna trovata entro 30 secondi` | Penna spenta, troppo lontana o già collegata al telefono. |

## Impostazioni

- **Sincronizza da sola quando accendi la penna**: attivo di default.
- **Mentre la penna è accesa, sincronizza ogni (minuti)**: 5 di default.
- **Memoria della penna** e **Rileggi tutto dalla penna** (riscarica tutte le pagine e ridisegna le immagini, senza ritrascrivere).
- **Log dettagliato dell'SDK**: per il debug, nella console (`Ctrl+Shift+I`).

## Sviluppo

```bash
npm install
npm run build      # typecheck + build in dist/main.js
npm run dev        # build continua mentre modifichi
```

Struttura:

```
src/main.ts                 plugin, comandi, barra di stato
src/pen/PenConnection.ts    Bluetooth + SDK: connessione, lettura e cancellazione della memoria della penna
src/pen/PenWatcher.ts       collegamento automatico quando la penna si accende
src/pen/electronChooser.ts  risponde a "select-bluetooth-device" di Electron
src/store/PageStore.ts      pagine lette dalla penna (in memoria) → SVG; indice di cosa è trascritto
src/render/svg.ts           disegno vettoriale della pagina
src/views/LiveView.ts       pannello laterale
src/diagnostics.ts          fase 0
src/shims/zlib.ts           zlib → fflate (funziona anche su mobile)
vendor/web_pen_sdk/         SDK web ufficiale NeoLAB (GPL-3.0), alleggerito
```

## Licenza

GPL-3.0, perché incorpora l'SDK web di NeoLAB, rilasciato con quella licenza. Va benissimo per uso personale; se un giorno lo pubblichi, il codice deve restare aperto.

## Anche sul telefono

Questo plugin vive nel progetto dell'app NeoTransfer (cartella `plugin/`): lo stesso codice che gira in Obsidian
gira anche nell'app sul telefono, che trascrive le pagine e scrive le note nel vault anche con Obsidian chiuso
(`src/phone/`: il modulo `obsidian` fatto sui file del vault, una tela per l'immagine, il motore).
Le impostazioni e lo stato restano quelli del plugin (`.obsidian/plugins/neo-pen/data.json`), con lo stesso turno
(`NeoPen/_turno.json`): chi trascrive dopo sa cosa è già fatto. Build del plugin: `npm ci && npm run build`.
