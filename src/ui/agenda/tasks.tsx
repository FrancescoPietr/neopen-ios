// "Attività" (Todoist): only tasks. «In programma»: late, today, the next days, later, without a date.
// «Progetti»: Inbox, projects, filters, labels, notes with tasks.
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { agenda } from "../../app/agenda";
import { byDateTime, overdue } from "../../core/taskStore";
import { VaultTask, addDays, parseYmd } from "../../core/tasks";
import { C, Empty, SectionHeader, Segmented, TaskRow, dayLabel, today, useAgenda } from "./common";
import { ListFilter, ProjectsScreen, TaskListScreen } from "./projects";

const cap = (x: string) => x.replace(/^\p{L}/u, (c) => c.toUpperCase());
const WD = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MO = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const longDate = (d: string) => {
  const x = parseYmd(d);
  return `${WD[x.getDay()]} ${x.getDate()} ${MO[x.getMonth()]}`;
};

function Planned({ onTask }: { onTask: (t: VaultTask) => void }) {
  const a = useAgenda();
  const t = today();
  const horizon = addDays(t, 14);
  const late = overdue(a.tasks, t);
  const todays = a.tasks.filter((x) => x.date === t && (!x.done || x.doneDate === t)).sort((x, y) => Number(x.done) - Number(y.done) || byDateTime(x, y));
  const open = a.tasks.filter((x) => !x.done);
  const next = open.filter((x) => x.date && x.date > t && x.date <= horizon).sort(byDateTime);
  const later = open.filter((x) => x.date && x.date > horizon).sort(byDateTime);
  const undated = open.filter((x) => !x.date).sort(byDateTime);
  const [showUndated, setShowUndated] = useState(true);
  const byDay = new Map<string, VaultTask[]>();
  for (const x of next) byDay.set(x.date!, [...(byDay.get(x.date!) ?? []), x]);
  const todo = todays.filter((x) => !x.done).length;

  return (
    <>
      {late.length ? <SectionHeader title="In ritardo" color={C.red} right={String(late.length)} /> : null}
      {late.map((x) => (
        <TaskRow key={x.id} task={x} showDate onPress={() => onTask(x)} />
      ))}

      <SectionHeader title={`Oggi · ${longDate(t)}`} right={todo ? `${todo} da fare` : undefined} />
      {todays.length ? todays.map((x) => <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />) : <Text style={st.free}>Niente per oggi.</Text>}

      {[...byDay.entries()].map(([d, list]) => (
        <View key={d}>
          <SectionHeader title={d === addDays(t, 1) ? `Domani · ${longDate(d)}` : cap(longDate(d))} right={String(list.length)} />
          {list.map((x) => (
            <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />
          ))}
        </View>
      ))}

      {later.length ? <SectionHeader title="Più avanti" right={String(later.length)} /> : null}
      {later.map((x) => (
        <TaskRow key={x.id} task={x} showDate onPress={() => onTask(x)} />
      ))}

      {undated.length ? (
        <Pressable onPress={() => setShowUndated(!showUndated)}>
          <SectionHeader title={`Senza data ${showUndated ? "▾" : "▸"}`} right={String(undated.length)} />
        </Pressable>
      ) : null}
      {showUndated
        ? undated.map((x) => (
            <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />
          ))
        : null}
      {!late.length && !todays.length && !next.length && !later.length && !undated.length ? <Empty text="Nessuna attività. Tocca + per aggiungerne una." /> : null}
    </>
  );
}

export function TasksScreen({ onTask, onProject }: { onTask: (t: VaultTask) => void; onProject: (name: string | null) => void }) {
  const a = useAgenda();
  const [mode, setMode] = useState<"planned" | "projects">("planned");
  const [list, setList] = useState<ListFilter | null>(null);
  useEffect(() => onProject(null), []);
  const open = (f: ListFilter | null) => {
    setList(f);
    onProject(f?.kind === "project" ? f.name : null);
  };
  if (mode === "projects" && list) return <TaskListScreen filter={list} onBack={() => open(null)} onTask={onTask} />;
  return (
    <View style={{ flex: 1 }}>
      <Text style={st.title}>Attività</Text>
      <Segmented
        value={mode}
        onChange={(v) => {
          setMode(v);
          open(null);
        }}
        options={[
          { value: "planned", label: "In programma" },
          { value: "projects", label: "Progetti" },
        ]}
      />
      {mode === "planned" ? (
        <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 140 }}>
          <Planned onTask={onTask} />
        </ScrollView>
      ) : (
        <ProjectsScreen onOpen={open} showTitle={false} />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  title: { fontSize: 32, fontWeight: "700", color: C.text, paddingHorizontal: 16, paddingTop: 8 },
  free: { color: C.faint, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, backgroundColor: C.card },
});
