// Screens (UI in Italian: the app is for Francesco).
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Dot, Glyph, HandFrame, HandSwitch, RowLine, Text, TextInput } from "./theme/ui";
import { T, themed } from "./theme/theme";
import { agenda } from "../app/agenda";
import { model, Snapshot } from "../app/model";

export const useModel = (): Snapshot => useSyncExternalStore(model.subscribe, model.getSnapshot);

/** Colors of the current look. */
const C = {
  get bg() {
    return T.paper;
  },
  get card() {
    return T.card;
  },
  get text() {
    return T.ink;
  },
  get sub() {
    return T.inkSoft;
  },
  get line() {
    return T.line;
  },
  get blue() {
    return T.accent;
  },
  get green() {
    return T.green;
  },
  get orange() {
    return T.orange;
  },
  get red() {
    return T.red;
  },
  get gray() {
    return T.faint;
  },
};

// ---------------------------------------------------------------- building blocks

function Section({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      {title ? <Text style={s.sectionTitle}>{title}</Text> : null}
      <HandFrame style={s.card}>{children}</HandFrame>
      {footer ? <Text style={s.footer}>{footer}</Text> : null}
    </View>
  );
}

function Row({ label, value, color }: { label: string; value?: string; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, color ? { color } : null]}>{label}</Text>
      {value !== undefined ? <Text style={s.rowValue}>{value}</Text> : null}
      <RowLine />
    </View>
  );
}

function Button({ label, onPress, disabled, color = C.blue, busy }: { label: string; onPress: () => void; disabled?: boolean; color?: string; busy?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.line }]}>
      {busy ? <ActivityIndicator color={C.blue} /> : <Text style={[s.button, { color: disabled ? C.gray : color }]}>{label}</Text>}
      <RowLine />
    </Pressable>
  );
}

function IconButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, { gap: 12 }, pressed && { backgroundColor: C.line }]}>
      <Glyph name={icon} size={22} color={C.blue} />
      <Text style={[s.button, { color: C.text, flex: 1 }]}>{label}</Text>
      <Glyph name="nav.next" size={14} color={C.gray} />
      <RowLine />
    </Pressable>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, { flex: 1 }]}>{label}</Text>
      <HandSwitch value={value} onChange={onChange} />
      <RowLine />
    </View>
  );
}

const time = (d: Date) => d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- status

function status(m: Snapshot): { title: string; detail: string; color: string; symbol: string } {
  switch (m.bleState) {
    case "bluetoothOff":
      return { title: "Bluetooth spento", detail: "Accendilo dal Centro di Controllo.", color: C.red, symbol: "error" };
    case "unauthorized":
      return { title: "Bluetooth non permesso", detail: "Impostazioni → Neo Pen → Bluetooth.", color: C.red, symbol: "error" };
    case "starting":
      return { title: "Avvio…", detail: "", color: C.gray, symbol: "wait" };
    case "noPen":
      return { title: "Nessuna penna", detail: "Tocca «Collega la penna» con il tappo tolto.", color: C.orange, symbol: "question" };
    case "searching":
      return { title: "Cerco la penna…", detail: "Togli il tappo e tienila vicina.", color: C.blue, symbol: "search" };
    case "waiting":
      return { title: "In attesa della penna", detail: "Togli il tappo: si collega da sola, anche con l'app chiusa.", color: C.gray, symbol: "pen" };
    case "connecting":
      return { title: "Mi collego…", detail: "", color: C.blue, symbol: "link" };
    case "ready":
      switch (m.phase.kind) {
        case "handshake":
          return { title: "Penna accesa", detail: "Mi presento alla penna…", color: C.blue, symbol: "pen" };
        case "syncing":
          return { title: "Scarico la memoria", detail: `Pagina ${Math.min(m.phase.done + 1, m.phase.total)} di ${m.phase.total}`, color: C.blue, symbol: "download" };
        case "listening":
          return { title: "Scrivi pure", detail: "Ogni tratto arriva subito sul telefono.", color: C.green, symbol: "write" };
        case "needsPassword":
          return { title: "Serve la password", detail: "Scrivila nelle impostazioni.", color: C.orange, symbol: "lock" };
        default:
          return { title: "Penna collegata", detail: "", color: C.green, symbol: "ok" };
      }
  }
}

function StatusCard({ m }: { m: Snapshot }) {
  const st = status(m);
  return (
    <HandFrame style={s.status} color={st.color} weight={1.3}>
      <View style={s.badge}>
        <Glyph name={st.symbol} size={40} color={st.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.statusTitle}>{st.title}</Text>
        {st.detail ? <Text style={s.statusDetail}>{st.detail}</Text> : null}
        {m.phase.kind === "syncing" ? (
          <View style={s.progress}>
            <View style={[s.progressFill, { width: `${Math.round((m.phase.done / Math.max(1, m.phase.total)) * 100)}%` }]} />
          </View>
        ) : null}
      </View>
    </HandFrame>
  );
}

// ---------------------------------------------------------------- home

export function HomeScreen({ go }: { go: (screen: "settings" | "log" | "look" | "alerts") => void }) {
  const m = useModel();
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={s.largeTitle}>Neo Pen</Text>
      <StatusCard m={m} />

      {!m.configured ? (
        <Section footer="Serve una volta sola: indirizzo e chiave sono nella nota «Collegamento iPhone» in Obsidian.">
          <Button label="Collega lo script del PC" color={C.orange} onPress={() => go("settings")} />
        </Section>
      ) : null}

      <Section title="Penna">
        {m.hasPen ? (
          <>
            <Row label="Penna" value={m.penName || "Neo Smartpen"} />
            {m.battery !== null ? <Row label="Batteria" value={m.battery > 100 ? "in carica" : `${m.battery}%`} /> : null}
          </>
        ) : m.bleState === "searching" ? (
          <>
            <View style={s.row}>
              <ActivityIndicator />
              <Text style={[s.rowLabel, { marginLeft: 10 }]}>Cerco la penna… togli il tappo</Text>
            </View>
            <Button label="Annulla" onPress={model.stopSearch} />
          </>
        ) : (
          <Button label="Collega la penna" onPress={model.searchPen} disabled={m.bleState === "bluetoothOff" || m.bleState === "unauthorized"} />
        )}
      </Section>

      <Section title="Pagine" footer="Le pagine vanno anche allo script Google: se il PC ha Obsidian aperto le prende lui; altrimenti le note le scrive il telefono (Impostazioni → Pagine → note di Obsidian).">
        <Row label="Pagine sul telefono" value={String(m.pagesCount)} />
        <Row label="Da inviare al PC" value={String(m.pendingCount)} />
        {m.lastUpload ? <Row label="Ultimo invio" value={time(m.lastUpload)} /> : null}
        {m.uploadError ? <Row label={m.uploadError} color={C.red} /> : null}
        <Button label={m.uploading ? "Invio in corso…" : "Invia ora"} onPress={model.sendNow} disabled={m.uploading || !m.configured} />
      </Section>

      <Section>
        <IconButton icon="bell" label="Avvisi e schermata di blocco" onPress={() => go("alerts")} />
        <IconButton icon="palette" label="Aspetto" onPress={() => go("look")} />
        <IconButton icon="settings" label="Impostazioni" onPress={() => go("settings")} />
        <IconButton icon="log" label="Registro" onPress={() => go("log")} />
      </Section>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- settings

/** Which iPhone calendar gets the events written with the pen. */
function PenCalendar({ value }: { value: string[] }) {
  const a = useSyncExternalStore(agenda.subscribe, agenda.getSnapshot);
  const cals = a.calendars.filter((c) => c.writable);
  if (a.calendarAccess !== "granted") {
    return (
      <Section title="Calendari degli eventi dalla penna" footer="Serve l'accesso al calendario dell'iPhone.">
        <Button label="Consenti l'accesso al calendario" onPress={() => void agenda.initCalendar(true)} />
      </Section>
    );
  }
  const chosen = value.filter((id) => cals.some((c) => c.id === id));
  const toggle = (id: string) => model.update({ penCalendars: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  const row = (key: string, label: string, on: boolean, onPress: () => void, color?: string) => (
    <Pressable key={key} onPress={onPress} style={({ pressed }) => [s.row, { gap: 10 }, pressed && { backgroundColor: C.line }]}>
      {color ? <Dot size={10} color={color} /> : <View style={{ width: 12 }} />}
      <Text style={[s.rowLabel, { flex: 1 }]}>{label}</Text>
      {on ? <Glyph name="check.done" size={18} color={C.blue} weight={1.2} /> : null}
      <RowLine />
    </Pressable>
  );
  return (
    <Section
      title="Calendari degli eventi dalla penna"
      footer="Puoi sceglierne più di uno: ogni evento scritto con la penna va in tutti quelli spuntati (nell'app lo vedi una volta sola). Nessuno spuntato = il calendario predefinito dell'iPhone. Il calendario Google c'è se è aggiunto all'iPhone (Impostazioni → Calendario → Account)."
    >
      {row("default", "Calendario predefinito dell'iPhone", !chosen.length, () => model.update({ penCalendars: [] }))}
      {cals.map((c) => row(c.id, c.title, chosen.includes(c.id), () => toggle(c.id), c.color))}
    </Section>
  );
}

export function SettingsScreen() {
  const m = useModel();
  const st = m.settings;
  const [result, setResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [vaultName, setVaultName] = useState<string | null>(() => model.vaultName());

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    setResult(model.pasteConfig(text) ? "Incollati dagli appunti." : "Negli appunti non trovo indirizzo o chiave.");
  };

  const test = async () => {
    setTesting(true);
    setResult(await model.testScript());
    setTesting(false);
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Section
        title="Script del PC"
        footer="In Obsidian: Impostazioni → Neo Pen → «Lettura dall'iPhone» → «Crea la nota». Copia la nota e tocca «Incolla»."
      >
        <Button label="Incolla dalla nota «Collegamento iPhone»" onPress={paste} />
        <TextInput
          style={[s.input, s.mono]}
          value={st.scriptURL}
          onChangeText={(v) => model.update({ scriptURL: v })}
          placeholder="https://script.google.com/…/exec"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          multiline
        />
        <TextInput
          style={s.input}
          value={st.secret}
          onChangeText={(v) => model.update({ secret: v })}
          placeholder="Chiave segreta"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Button label="Prova lo script" onPress={test} disabled={!m.configured} busy={testing} />
        {result ? <Text style={s.note}>{result}</Text> : null}
      </Section>

      <Section
        title="Penna"
        footer={
          "Tempo reale: mentre la penna è collegata ogni tratto arriva subito (la penna allora non lo salva in memoria: lo salva il telefono).\n" +
          "Svuota la penna: la memoria della penna si cancella dopo che le pagine sono sul telefono, così ogni collegamento scarica solo le novità.\n" +
          "Salta le invariate: più veloce, ma con Bluefy la penna smetteva di rispondere; provalo e guarda il registro.\n" +
          "Valgono dal collegamento successivo."
        }
      >
        <Toggle label="Tratti in tempo reale" value={st.live} onChange={(v) => model.update({ live: v })} />
        <Toggle label="Svuota la penna dopo lo scaricamento" value={st.deleteAfterDownload} onChange={(v) => model.update({ deleteAfterDownload: v })} />
        <Toggle label="Salta le pagine invariate (prova)" value={st.skipUnchanged} onChange={(v) => model.update({ skipUnchanged: v })} />
        <TextInput
          style={s.input}
          value={st.penPassword}
          onChangeText={(v) => model.update({ penPassword: v })}
          placeholder="Password della penna (se ce l'ha)"
          keyboardType="number-pad"
          secureTextEntry
        />
      </Section>

      <Section
        title="Penna → calendario e attività"
        footer={
          "Quando smetti di scrivere (penna spenta, o 2 minuti senza tratti) il telefono legge i tratti nuovi con Claude, anche a telefono bloccato e PC spento: " +
          "le attività con un orario diventano eventi nel calendario dell'iPhone, le altre vanno nella nota del giorno del vault (sezione «Attività»). " +
          "Quando Obsidian trascrive la pagina prende il posto di queste righe, senza doppioni. La chiave resta solo su questo telefono.\n" +
          "Con «Pagine → note di Obsidian» attivo questa lettura veloce si ferma: attività e appuntamenti arrivano dalle note, come nel plugin."
        }
      >
        <TextInput
          style={[s.input, s.mono]}
          value={st.testKey}
          onChangeText={(v) => model.update({ testKey: v })}
          placeholder="Chiave di Claude (sk-ant-…)"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Toggle label="Penna → calendario e attività" value={st.phoneEvents} onChange={(v) => model.update({ phoneEvents: v })} />
        <Button
          label="Recupera tutto quello che hai già scritto"
          disabled={!st.phoneEvents || !st.testKey.trim()}
          onPress={() =>
            Alert.alert(
              "Recuperare le cose vecchie?",
              "Rileggo tutte le pagine sul telefono, giorno per giorno, e aggiungo al calendario e alle attività quello che manca (quello che c'è già non si raddoppia). Ci vuole qualche minuto.",
              [
                { text: "Annulla", style: "cancel" },
                { text: "Recupera", onPress: model.recoverAll },
              ]
            )
          }
        />
        <Button label="Prova Claude a telefono bloccato" onPress={model.testClaude} disabled={!st.testKey.trim()} />
      </Section>

      <Section
        title="Pagine → note di Obsidian"
        footer={
          "Quando smetti di scrivere il telefono trascrive la pagina e scrive la sua nota nel vault, come il plugin Neo Pen in Obsidian " +
          "(stesse regole dei #tag, template, cartella del taccuino, disegni), anche con Obsidian chiuso e il telefono bloccato. " +
          "Usa le impostazioni e la chiave di Claude del plugin. Trascrive solo il telefono: Obsidian (PC o iPhone) lo sa e non rifà le pagine, " +
          "le note gli arrivano con la sincronizzazione.\n" +
          "Il calendario segue le note: un'attività con l'orario diventa un evento (anche se l'orario lo scrivi dopo, accanto); " +
          "cancellata sulla carta, l'evento sparisce; orario o data corretti, l'evento si sposta."
        }
      >
        <Toggle label="Pagine → note di Obsidian" value={st.pageNotes} onChange={(v) => model.update({ pageNotes: v })} />
      </Section>

      <PenCalendar value={st.penCalendars} />

      <Section
        title="Cartella del vault"
        footer="La cartella del tuo vault in File → Sul mio iPhone → Obsidian: lì l'app legge e scrive le attività."
      >
        <Row label="Cartella" value={vaultName ?? "non scelta"} />
        <Button
          label="Scegli la cartella del vault"
          onPress={async () => {
            const n = await model.pickVault();
            if (n) setVaultName(n);
          }}
        />
        <Button label="Prova scrittura adesso" onPress={() => model.vaultTest()} disabled={!vaultName} />
      </Section>

      <Section>
        <Button
          label="Rimanda tutte le pagine al PC"
          onPress={() =>
            Alert.alert("Rimandare tutte le pagine al PC?", undefined, [
              { text: "Annulla", style: "cancel" },
              { text: "Rimanda tutte", onPress: model.resendAll },
            ])
          }
        />
        {m.hasPen ? (
          <Button
            label="Dimentica la penna"
            color={C.red}
            onPress={() =>
              Alert.alert("Dimenticare la penna?", "Per usarla di nuovo dovrai ricollegarla. Le pagine sul telefono restano.", [
                { text: "Annulla", style: "cancel" },
                { text: "Dimentica", style: "destructive", onPress: model.forgetPen },
              ])
            }
          />
        ) : null}
      </Section>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- log

export function LogScreen() {
  const m = useModel();
  const share = async () => {
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(model.logPath, { mimeType: "text/plain", UTI: "public.plain-text" });
  };
  return (
    <View style={s.screen}>
      <FlatList
        data={[...m.log].reverse()}
        keyExtractor={(l) => String(l.id)}
        contentContainerStyle={s.content}
        ListHeaderComponent={
          <Section>
            <Button label="Condividi il registro" onPress={share} />
          </Section>
        }
        renderItem={({ item }) => (
          <View style={s.logLine}>
            <Text style={s.logTime}>{item.time.toLocaleTimeString("it-IT")}</Text>
            <Text style={s.logText}>{item.text}</Text>
            <RowLine left={0} />
          </View>
        )}
      />
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  largeTitle: { fontSize: 38, fontWeight: "700", color: C.text, marginBottom: 12 },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 16, color: C.sub, marginLeft: 12, marginBottom: 4 },
  footer: { fontSize: 14, color: C.sub, marginHorizontal: 12, marginTop: 6, lineHeight: 19 },
  card: { paddingVertical: 3 },
  row: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center" },
  rowLabel: { fontSize: 18, color: C.text },
  rowValue: { fontSize: 18, color: C.sub, marginLeft: "auto" },
  button: { fontSize: 18 },
  input: { fontSize: 17, color: C.text, paddingHorizontal: 16, paddingVertical: 12 },
  mono: { fontFamily: "Menlo", fontSize: 13 },
  note: { fontSize: 13, color: C.sub, paddingHorizontal: 16, paddingVertical: 10 },
  status: { flexDirection: "row", alignItems: "center", padding: 16, marginBottom: 22, gap: 14 },
  badge: { width: 52, height: 52, alignItems: "center", justifyContent: "center" },
  statusTitle: { fontSize: 20, fontWeight: "700", color: C.text },
  statusDetail: { fontSize: 16, color: C.sub, marginTop: 2 },
  progress: { height: 4, backgroundColor: C.line, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  progressFill: { height: 4, backgroundColor: C.blue },
  logLine: { paddingVertical: 6 },
  logTime: { fontSize: 11, color: C.sub },
  logText: { fontSize: 14, color: C.text },
}));
