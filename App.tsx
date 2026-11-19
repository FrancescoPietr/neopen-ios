import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { BackBar, Glyph, HandFrame, HandLine, Paper, Text } from "./src/ui/theme/ui";
import { T, theme, themed } from "./src/ui/theme/theme";
import { roughBlob } from "./src/ui/theme/rough";
import Svg, { Path } from "react-native-svg";
import { LookScreen } from "./src/ui/look";
import { AlertsScreen } from "./src/ui/alertsScreen";

import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { agenda, CalEvent } from "./src/app/agenda";
import { VaultTask } from "./src/core/tasks";
import { CalendarScreen } from "./src/ui/agenda/calendar";
import { C, useAgenda } from "./src/ui/agenda/common";
import { EventSheet, QuickAddSheet, TaskEditor } from "./src/ui/agenda/sheets";
import { TasksScreen } from "./src/ui/agenda/tasks";
import { HomeScreen, LogScreen, SettingsScreen } from "./src/ui/screens";

type Tab = "tasks" | "calendar" | "pen";
type PenScreen = "home" | "settings" | "log" | "look" | "alerts";
const PEN_TITLES: Record<PenScreen, string> = { home: "", settings: "Impostazioni", log: "Registro", look: "", alerts: "" };

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "tasks", icon: "tab.tasks", label: "Attività" },
  { id: "calendar", icon: "tab.calendar", label: "Calendario" },
  { id: "pen", icon: "tab.pen", label: "Penna" },
];
/** Schermo largo (iPhone Duo aperto, pieghevoli): attività e calendario stanno insieme, uno accanto all'altro. */
const WIDE_TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "tasks", icon: "tab.calendar", label: "Agenda" },
  { id: "pen", icon: "tab.pen", label: "Penna" },
];
/** Da quanti punti di larghezza lo schermo si divide in due (un iPhone normale, anche in orizzontale, no). */
const WIDE = 700;

/** Calendar and task manager (Fantastical + Todoist) on the Obsidian vault, plus the pen. */
export default function App() {
  // the look changed: everything is drawn again with the new colors and handwriting
  useSyncExternalStore(theme.subscribe, () => theme.version);
  const a = useAgenda();
  const [tab, setTab] = useState<Tab>("tasks");
  const [pen, setPen] = useState<PenScreen>("home");
  const [task, setTask] = useState<VaultTask | null>(null);
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  /** From a widget: open a day of the calendar (or the month), or the tasks. */
  const [jump, setJump] = useState<{ day: string | null; at: number } | null>(null);
  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const m = url ? /neotransfer:\/\/(giorno|mese|attivita)(?:\/(\d{4}-\d{2}-\d{2}))?/.exec(url) : null;
      if (!m) return;
      if (m[1] === "attivita") setTab("tasks");
      else {
        setTab("calendar");
        setJump({ day: m[2] ?? null, at: Date.now() });
      }
    };
    void Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener("url", (e) => open(e.url));
    return () => sub.remove();
  }, []);

  // the agenda starts when the app is on screen (not when iOS wakes it in the background for the pen)
  useEffect(() => {
    const go = () => {
      agenda.start();
      if (agenda.getSnapshot().calendarAccess === "unknown") void agenda.initCalendar(true);
    };
    if (AppState.currentState === "active") go();
    const sub = AppState.addEventListener("change", (st) => st === "active" && go());
    return () => sub.remove();
  }, []);

  // iPhone Duo aperto (o un altro schermo largo): attività a sinistra e calendario a destra, insieme. Chiuso torna
  // tutto come su un iPhone normale, sulla scheda dov'eri.
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const agendaTab = tab === "tasks" || tab === "calendar";
  const contextDay = tab === "calendar" || (wide && agendaTab) ? day : null;
  // the + button: on the tasks and on a day of the calendar (the month has its own «+ Nuovo»)
  const showFab = (wide && agendaTab) || tab === "tasks" || (tab === "calendar" && !!day);
  const tabs = wide ? WIDE_TABS : TABS;
  const tabOn = (id: Tab) => (wide && id === "tasks" ? agendaTab : tab === id);

  return (
    <SafeAreaProvider>
      <Paper>
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        <StatusBar style={T.dark ? "light" : "dark"} />
        {a.error ? (
          <Pressable onPress={agenda.clearError} style={styles.error}>
            <Text style={styles.errorText}>{a.error}</Text>
          </Pressable>
        ) : null}
        {!a.vaultName && tab === "tasks" ? (
          <HandFrame style={styles.setup} seed="setup">
            <Text style={styles.setupTitle}>Collega il vault di Obsidian</Text>
            <Text style={styles.setupText}>
              Per vedere qui le attività delle tue note e quelle scritte con la penna, scegli la cartella del vault in File → Sul mio iPhone → Obsidian.
            </Text>
            <Pressable onPress={() => void agenda.pickVault()}>
              <HandFrame style={styles.setupBtn} color={C.accent} fill={C.accent + "26"} seed="setupbtn">
                <Text style={styles.setupBtnText}>Scegli la cartella del vault</Text>
              </HandFrame>
            </Pressable>
          </HandFrame>
        ) : null}

        <View style={{ flex: 1 }}>
          {wide && agendaTab ? (
            <View style={styles.split}>
              <View style={{ flex: 1 }}>
                <TasksScreen onTask={setTask} />
              </View>
              <View style={styles.splitLine} />
              <View style={{ flex: 1.25 }}>
                <CalendarScreen onTask={setTask} onEvent={setEvent} onDayChange={setDay} onAdd={() => setAdding(true)} jump={jump} />
              </View>
            </View>
          ) : null}
          {!wide && tab === "tasks" ? <TasksScreen onTask={setTask} /> : null}
          {!wide && tab === "calendar" ? <CalendarScreen onTask={setTask} onEvent={setEvent} onDayChange={setDay} onAdd={() => setAdding(true)} jump={jump} /> : null}
          {tab === "pen" ? (
            // (su uno schermo largo le impostazioni restano larghe come su un telefono, in mezzo: righe lunghe si leggono male)
            <View style={[{ flex: 1 }, wide && styles.narrow]}>
              {/* Aspetto has its own bar (inside it, the drawing screen goes back to Aspetto, not to Penna) */}
              {pen !== "home" && pen !== "look" && pen !== "alerts" ? <BackBar label="Penna" onPress={() => setPen("home")} title={PEN_TITLES[pen]} /> : null}
              {pen === "home" ? (
                <HomeScreen go={setPen} />
              ) : pen === "settings" ? (
                <SettingsScreen />
              ) : pen === "look" ? (
                <LookScreen onBack={() => setPen("home")} />
              ) : pen === "alerts" ? (
                <AlertsScreen onBack={() => setPen("home")} />
              ) : (
                <LogScreen />
              )}
            </View>
          ) : null}
        </View>

        {showFab ? (
          <Pressable onPress={() => setAdding(true)} style={styles.fab}>
            <Svg width={62} height={62} style={{ position: "absolute" }}>
              <Path d={roughBlob(31, 31, 27, "fab", 0.07)} fill={C.accent} />
            </Svg>
            <Glyph name="add" size={24} color={T.onAccent} weight={1.4} />
          </Pressable>
        ) : null}

        <SafeAreaView edges={["bottom"]} style={styles.tabs}>
          <HandLine style={{ position: "absolute", left: 6, right: 6, top: -3 }} seed="tabs" />
          {tabs.map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tab}>
              <Glyph name={t.icon} size={26} color={tabOn(t.id) ? C.accent : T.faint} weight={tabOn(t.id) ? 1.2 : 1} />
              <Text style={[styles.tabLabel, tabOn(t.id) && { color: C.accent, fontWeight: "700" }]}>{t.label}</Text>
            </Pressable>
          ))}
        </SafeAreaView>

        <QuickAddSheet visible={adding} onClose={() => setAdding(false)} date={contextDay} />
        <TaskEditor task={task} onClose={() => setTask(null)} />
        <EventSheet ev={event} onClose={() => setEvent(null)} />
      </SafeAreaView>
      </Paper>
    </SafeAreaProvider>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { flex: 1 },
    split: { flex: 1, flexDirection: "row" },
    splitLine: { width: StyleSheet.hairlineWidth, backgroundColor: T.faint, opacity: 0.5, marginVertical: 8 },
    narrow: { width: "100%", maxWidth: 620, alignSelf: "center" },
    bar: { height: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
    back: { fontSize: 18, color: T.accent },
    title: { fontSize: 19, fontWeight: "700", color: T.ink },
    tabs: { flexDirection: "row", backgroundColor: T.paper },
    tab: { flex: 1, alignItems: "center", paddingTop: 8, paddingBottom: 2, gap: 1 },
    tabLabel: { fontSize: 12, color: T.faint },
    fab: { position: "absolute", right: 18, bottom: 100, width: 62, height: 62, alignItems: "center", justifyContent: "center" },
    error: { backgroundColor: T.red + "22", padding: 10, marginHorizontal: 12, borderRadius: 8, marginTop: 4 },
    errorText: { color: T.red, fontSize: 14 },
    setup: { margin: 16, padding: 16, gap: 10 },
    setupTitle: { fontSize: 22, fontWeight: "700", color: T.ink },
    setupText: { fontSize: 16, color: T.inkSoft, lineHeight: 22 },
    setupBtn: { paddingVertical: 12, alignItems: "center" },
    setupBtnText: { color: T.accent, fontSize: 18, fontWeight: "700" },
  })
);
