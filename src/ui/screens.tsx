// Screens (UI in Italian: the app is for Francesco).
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { model, Snapshot } from "../app/model";

export const useModel = (): Snapshot => useSyncExternalStore(model.subscribe, model.getSnapshot);

const C = {
  bg: "#F2F2F7",
  card: "#FFFFFF",
  text: "#1C1C1E",
  sub: "#6C6C70",
  line: "#E5E5EA",
  blue: "#0A63D6",
  green: "#1E9E4A",
  orange: "#D9730D",
  red: "#D12F2F",
  gray: "#8E8E93",
};

// ---------------------------------------------------------------- building blocks

function Section({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      {title ? <Text style={s.sectionTitle}>{title.toUpperCase()}</Text> : null}
      <View style={s.card}>{children}</View>
      {footer ? <Text style={s.footer}>{footer}</Text> : null}
    </View>
  );
}

function Row({ label, value, color }: { label: string; value?: string; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, color ? { color } : null]}>{label}</Text>
      {value !== undefined ? <Text style={s.rowValue}>{value}</Text> : null}
    </View>
  );
}

function Button({ label, onPress, disabled, color = C.blue, busy }: { label: string; onPress: () => void; disabled?: boolean; color?: string; busy?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.line }]}>
      {busy ? <ActivityIndicator /> : <Text style={[s.button, { color: disabled ? C.gray : color }]}>{label}</Text>}
    </Pressable>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const time = (d: Date) => d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- status

function status(m: Snapshot): { title: string; detail: string; color: string; symbol: string } {
  switch (m.bleState) {
    case "bluetoothOff":
      return { title: "Bluetooth spento", detail: "Accendilo dal Centro di Controllo.", color: C.red, symbol: "✕" };
    case "unauthorized":
      return { title: "Bluetooth non permesso", detail: "Impostazioni → Neo Pen → Bluetooth.", color: C.red, symbol: "✋" };
    case "starting":
      return { title: "Avvio…", detail: "", color: C.gray, symbol: "…" };
    case "noPen":
      return { title: "Nessuna penna", detail: "Tocca «Collega la penna» con il tappo tolto.", color: C.orange, symbol: "?" };
    case "searching":
      return { title: "Cerco la penna…", detail: "Togli il tappo e tienila vicina.", color: C.blue, symbol: "⌕" };
    case "waiting":
      return { title: "In attesa della penna", detail: "Togli il tappo: si collega da sola, anche con l'app chiusa.", color: C.gray, symbol: "✎" };
    case "connecting":
      return { title: "Mi collego…", detail: "", color: C.blue, symbol: "⇄" };
    case "ready":
      switch (m.phase.kind) {
        case "handshake":
          return { title: "Penna accesa", detail: "Mi presento alla penna…", color: C.blue, symbol: "✎" };
        case "syncing":
          return { title: "Scarico la memoria", detail: `Pagina ${Math.min(m.phase.done + 1, m.phase.total)} di ${m.phase.total}`, color: C.blue, symbol: "↓" };
        case "listening":
          return { title: "Scrivi pure", detail: "Ogni tratto arriva subito sul telefono.", color: C.green, symbol: "✍" };
        case "needsPassword":
          return { title: "Serve la password", detail: "Scrivila nelle impostazioni.", color: C.orange, symbol: "🔒" };
        default:
          return { title: "Penna collegata", detail: "", color: C.green, symbol: "✓" };
      }
  }
}

function StatusCard({ m }: { m: Snapshot }) {
  const st = status(m);
  return (
    <View style={[s.status, { borderColor: st.color + "40" }]}>
      <View style={[s.badge, { backgroundColor: st.color + "22" }]}>
        <Text style={[s.badgeText, { color: st.color }]}>{st.symbol}</Text>
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
    </View>
  );
}

// ---------------------------------------------------------------- home

export function HomeScreen({ go }: { go: (screen: "settings" | "log") => void }) {
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

      <Section title="Pagine" footer="Le pagine vanno allo script Google; il PC con Obsidian aperto le prende e le trascrive.">
        <Row label="Pagine sul telefono" value={String(m.pagesCount)} />
        <Row label="Da inviare al PC" value={String(m.pendingCount)} />
        {m.lastUpload ? <Row label="Ultimo invio" value={time(m.lastUpload)} /> : null}
        {m.uploadError ? <Row label={m.uploadError} color={C.red} /> : null}
        <Button label={m.uploading ? "Invio in corso…" : "Invia ora"} onPress={model.sendNow} disabled={m.uploading || !m.configured} />
      </Section>

      <Section>
        <Button label="Impostazioni" onPress={() => go("settings")} />
        <Button label="Registro" onPress={() => go("log")} />
      </Section>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- settings

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
        title="Calendario dal telefono"
        footer={
          "Quando smetti di scrivere (penna spenta, o 2 minuti senza tratti) il telefono legge i tratti nuovi con Claude e mette subito nel calendario le attività con un orario, anche a telefono bloccato e PC spento. " +
          "Il resto (note, attività senza orario, spunte) lo fa Obsidian, che poi sostituisce questi eventi con i suoi. " +
          "Serve lo script Google aggiornato. La chiave resta solo su questo telefono."
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
        <Toggle label="Attività con orario subito nel calendario" value={st.phoneEvents} onChange={(v) => model.update({ phoneEvents: v })} />
        <Button label="Rimanda le attività senza orario scritte oggi" onPress={model.resendTodayTodos} disabled={!st.phoneEvents || !st.testKey.trim()} />
        <Button label="Prova Claude a telefono bloccato" onPress={model.testClaude} disabled={!st.testKey.trim()} />
      </Section>

      <Section
        title="Cartella del vault (prova)"
        footer="Scegli la cartella del tuo vault in File → Sul mio iPhone → Obsidian. Poi ogni volta che spegni la penna l'app prova a scrivere il file NeoPen/_telefono/prova-scrittura.md e nel Registro dice se ci è riuscita, anche a telefono bloccato."
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
          </View>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 16, paddingBottom: 40 },
  largeTitle: { fontSize: 34, fontWeight: "700", color: C.text, marginBottom: 12 },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 13, color: C.sub, marginLeft: 16, marginBottom: 6 },
  footer: { fontSize: 13, color: C.sub, marginHorizontal: 16, marginTop: 6, lineHeight: 18 },
  card: { backgroundColor: C.card, borderRadius: 12, overflow: "hidden" },
  row: { minHeight: 46, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  rowLabel: { fontSize: 17, color: C.text },
  rowValue: { fontSize: 17, color: C.sub, marginLeft: "auto" },
  button: { fontSize: 17 },
  input: { fontSize: 16, color: C.text, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  mono: { fontFamily: "Menlo", fontSize: 13 },
  note: { fontSize: 13, color: C.sub, paddingHorizontal: 16, paddingVertical: 10 },
  status: { flexDirection: "row", alignItems: "center", backgroundColor: C.card, borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 22, gap: 14 },
  badge: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 24, fontWeight: "600" },
  statusTitle: { fontSize: 17, fontWeight: "600", color: C.text },
  statusDetail: { fontSize: 15, color: C.sub, marginTop: 2 },
  progress: { height: 4, backgroundColor: C.line, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  progressFill: { height: 4, backgroundColor: C.blue },
  logLine: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  logTime: { fontSize: 11, color: C.sub },
  logText: { fontSize: 14, color: C.text },
});
