import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { agenda, CalEvent } from "./src/app/agenda";
import { VaultTask } from "./src/core/tasks";
import { CalendarScreen } from "./src/ui/agenda/calendar";
import { C, useAgenda } from "./src/ui/agenda/common";
import { ListFilter, ProjectsScreen, TaskListScreen } from "./src/ui/agenda/projects";
import { EventSheet, QuickAddSheet, TaskEditor } from "./src/ui/agenda/sheets";
import { TodayScreen } from "./src/ui/agenda/today";
import { HomeScreen, LogScreen, SettingsScreen } from "./src/ui/screens";

type Tab = "today" | "calendar" | "projects" | "pen";
type PenScreen = "home" | "settings" | "log";
const PEN_TITLES: Record<PenScreen, string> = { home: "", settings: "Impostazioni", log: "Registro" };

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "today", icon: "☀︎", label: "Oggi" },
  { id: "calendar", icon: "▦", label: "Calendario" },
  { id: "projects", icon: "☰", label: "Progetti" },
  { id: "pen", icon: "✎", label: "Penna" },
];

/** Calendar and task manager (Fantastical + Todoist) on the Obsidian vault, plus the pen. */
export default function App() {
  const a = useAgenda();
  const [tab, setTab] = useState<Tab>("today");
  const [pen, setPen] = useState<PenScreen>("home");
  const [list, setList] = useState<ListFilter | null>(null);
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

  const contextProject = tab === "projects" && list?.kind === "project" ? list.name : null;
  const contextDay = tab === "today" || tab === "calendar" ? day : null;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />
        {a.error ? (
          <Pressable onPress={agenda.clearError} style={styles.error}>
            <Text style={styles.errorText}>{a.error}</Text>
          </Pressable>
        ) : null}
        {!a.vaultName && tab !== "pen" ? (
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
          {tab === "today" && a.vaultName ? <TodayScreen onTask={setTask} onEvent={setEvent} onDayChange={setDay} /> : null}
          {tab === "calendar" ? <CalendarScreen onTask={setTask} onEvent={setEvent} onDayChange={setDay} /> : null}
          {tab === "projects" && a.vaultName ? list ? <TaskListScreen filter={list} onBack={() => setList(null)} onTask={setTask} /> : <ProjectsScreen onOpen={setList} /> : null}
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

        {tab !== "pen" && a.vaultName ? (
          <Pressable onPress={() => setAdding(true)} style={styles.fab}>
            <Text style={styles.fabText}>+</Text>
          </Pressable>
        ) : null}

        <SafeAreaView edges={["bottom"]} style={styles.tabs}>
          {TABS.map((t) => (
            <Pressable key={t.id} onPress={() => (t.id === tab && t.id === "projects" ? setList(null) : setTab(t.id))} style={styles.tab}>
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
