import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { agenda, CalEvent } from "./src/app/agenda";
import { VaultTask } from "./src/core/tasks";
import { CalendarScreen } from "./src/ui/agenda/calendar";
import { C, useAgenda } from "./src/ui/agenda/common";
import { EventSheet, QuickAddSheet, TaskEditor } from "./src/ui/agenda/sheets";
import { TasksScreen } from "./src/ui/agenda/tasks";
import { HomeScreen, LogScreen, SettingsScreen } from "./src/ui/screens";

type Tab = "tasks" | "calendar" | "pen";
type PenScreen = "home" | "settings" | "log";
const PEN_TITLES: Record<PenScreen, string> = { home: "", settings: "Impostazioni", log: "Registro" };

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "tasks", icon: "☑︎", label: "Attività" },
  { id: "calendar", icon: "▦", label: "Calendario" },
  { id: "pen", icon: "✎", label: "Penna" },
];

/** Calendar and task manager (Fantastical + Todoist) on the Obsidian vault, plus the pen. */
export default function App() {
  const a = useAgenda();
  const [tab, setTab] = useState<Tab>("tasks");
  const [pen, setPen] = useState<PenScreen>("home");
  const [project, setProject] = useState<string | null>(null);
  const [task, setTask] = useState<VaultTask | null>(null);
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState<string | null>(null);

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

  const contextProject = tab === "tasks" ? project : null;
  const contextDay = tab === "calendar" ? day : null;
  // the + button: on the tasks and on a day of the calendar (the month has its own «+ Nuovo»)
  const showFab = (tab === "tasks" && !!a.vaultName) || (tab === "calendar" && !!day);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />
        {a.error ? (
          <Pressable onPress={agenda.clearError} style={styles.error}>
            <Text style={styles.errorText}>{a.error}</Text>
          </Pressable>
        ) : null}
        {!a.vaultName && tab === "tasks" ? (
          <View style={styles.setup}>
            <Text style={styles.setupTitle}>Collega il vault di Obsidian</Text>
            <Text style={styles.setupText}>
              Le attività stanno nelle tue note: scegli la cartella del vault in File → Sul mio iPhone → Obsidian. Le nuove attività finiscono nella cartella «Attività» del vault.
            </Text>
            <Pressable onPress={() => void agenda.pickVault()} style={styles.setupBtn}>
              <Text style={styles.setupBtnText}>Scegli la cartella del vault</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ flex: 1 }}>
          {tab === "tasks" && a.vaultName ? <TasksScreen onTask={setTask} onProject={setProject} /> : null}
          {tab === "calendar" ? <CalendarScreen onTask={setTask} onEvent={setEvent} onDayChange={setDay} onAdd={() => setAdding(true)} /> : null}
          {tab === "pen" ? (
            <View style={{ flex: 1 }}>
              {pen !== "home" ? (
                <View style={styles.bar}>
                  <Pressable onPress={() => setPen("home")} hitSlop={12}>
                    <Text style={styles.back}>‹ Penna</Text>
                  </Pressable>
                  <Text style={styles.title}>{PEN_TITLES[pen]}</Text>
                  <View style={{ width: 80 }} />
                </View>
              ) : null}
              {pen === "home" ? <HomeScreen go={setPen} /> : pen === "settings" ? <SettingsScreen /> : <LogScreen />}
            </View>
          ) : null}
        </View>

        {showFab ? (
          <Pressable onPress={() => setAdding(true)} style={styles.fab}>
            <Text style={styles.fabText}>+</Text>
          </Pressable>
        ) : null}

        <SafeAreaView edges={["bottom"]} style={styles.tabs}>
          {TABS.map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tab}>
              <Text style={[styles.tabIcon, tab === t.id && { color: C.accent }]}>{t.icon}</Text>
              <Text style={[styles.tabLabel, tab === t.id && { color: C.accent }]}>{t.label}</Text>
            </Pressable>
          ))}
        </SafeAreaView>

        <QuickAddSheet visible={adding} onClose={() => setAdding(false)} project={contextProject} date={contextDay} />
        <TaskEditor task={task} onClose={() => setTask(null)} />
        <EventSheet ev={event} onClose={() => setEvent(null)} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F2F2F7" },
  bar: { height: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  back: { fontSize: 17, color: "#0A63D6", width: 80 },
  title: { fontSize: 17, fontWeight: "600", color: "#1C1C1E" },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#D1D1D6", backgroundColor: "#F9F9F9" },
  tab: { flex: 1, alignItems: "center", paddingTop: 6, paddingBottom: 4 },
  tabIcon: { fontSize: 20, color: "#8E8E93" },
  tabLabel: { fontSize: 10, color: "#8E8E93", marginTop: 1 },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 96,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  fabText: { color: "#fff", fontSize: 32, lineHeight: 34, fontWeight: "300" },
  error: { backgroundColor: "#FDECEC", padding: 10, marginHorizontal: 12, borderRadius: 8, marginTop: 4 },
  errorText: { color: "#A12020", fontSize: 13 },
  setup: { margin: 16, padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 10 },
  setupTitle: { fontSize: 20, fontWeight: "700", color: "#1C1C1E" },
  setupText: { fontSize: 15, color: "#6C6C70", lineHeight: 21 },
  setupBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  setupBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
