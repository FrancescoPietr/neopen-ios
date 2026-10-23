// "Progetti" (Todoist): Inbox, projects, notes with tasks, labels and priorities; each opens its task list.
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { agenda } from "../../app/agenda";
import { byDateTime, labels, projects } from "../../core/taskStore";
import { Priority, VaultTask } from "../../core/tasks";
import { C, Empty, PRIORITY_COLOR, SectionHeader, TaskRow, useAgenda } from "./common";

export type ListFilter = { kind: "project"; file: string; name: string } | { kind: "label"; name: string } | { kind: "priority"; p: Priority } | { kind: "nodate" } | { kind: "done" };

export function filterTitle(f: ListFilter): string {
  switch (f.kind) {
    case "project":
      return f.name;
    case "label":
      return `#${f.name}`;
    case "priority":
      return `Priorità ${f.p}`;
    case "nodate":
      return "Senza data";
    case "done":
      return "Completate";
  }
}

function applyFilter(tasks: VaultTask[], f: ListFilter): VaultTask[] {
  switch (f.kind) {
    case "project":
      return tasks.filter((t) => t.file === f.file);
    case "label":
      return tasks.filter((t) => !t.done && t.labels.includes(f.name)).sort(byDateTime);
    case "priority":
      return tasks.filter((t) => !t.done && t.priority === f.p).sort(byDateTime);
    case "nodate":
      return tasks.filter((t) => !t.done && !t.date);
    case "done":
      return tasks.filter((t) => t.done).sort((a, b) => (b.doneDate ?? "").localeCompare(a.doneDate ?? "")).slice(0, 100);
  }
}

function Item({ icon, label, count, color, onPress }: { icon: string; label: string; count?: number; color?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.item, pressed && { backgroundColor: C.line }]}>
      <Text style={[st.icon, color ? { color } : null]}>{icon}</Text>
      <Text style={st.itemLabel} numberOfLines={1}>
        {label}
      </Text>
      {count ? <Text style={st.count}>{count}</Text> : null}
    </Pressable>
  );
}

export function ProjectsScreen({ onOpen }: { onOpen: (f: ListFilter) => void }) {
  const a = useAgenda();
  const ps = projects(a.tasks);
  const own = ps.filter((p) => p.own);
  const notes = ps.filter((p) => !p.own);
  const ls = labels(a.tasks);
  const open = a.tasks.filter((t) => !t.done);
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 120 }}>
      <Text style={st.title}>Progetti</Text>
      <View style={st.card}>
        {(own.length ? own : [{ name: "Inbox", file: "Attività/Inbox.md", open: 0, own: true }]).map((p) => (
          <Item key={p.file} icon={p.name === "Inbox" ? "📥" : "#"} color={p.name === "Inbox" ? undefined : C.accent} label={p.name} count={p.open} onPress={() => onOpen({ kind: "project", file: p.file, name: p.name })} />
        ))}
      </View>
      <Text style={st.hint}>Un progetto è una nota nella cartella «Attività» del vault. Per crearne uno, scrivi +Nome nell'aggiunta rapida.</Text>

      <SectionHeader title="Filtri" />
      <View style={st.card}>
        {([1, 2, 3] as Priority[]).map((p) => (
          <Item key={p} icon="⚑" color={PRIORITY_COLOR[p]} label={`Priorità ${p}`} count={open.filter((t) => t.priority === p).length} onPress={() => onOpen({ kind: "priority", p })} />
        ))}
        <Item icon="∅" label="Senza data" count={open.filter((t) => !t.date).length} onPress={() => onOpen({ kind: "nodate" })} />
        <Item icon="✓" color={C.green} label="Completate" onPress={() => onOpen({ kind: "done" })} />
      </View>

      {ls.length ? <SectionHeader title="Etichette" /> : null}
      {ls.length ? (
        <View style={st.card}>
          {ls.map((l) => (
            <Item key={l.name} icon="🏷" label={l.name} count={l.open} onPress={() => onOpen({ kind: "label", name: l.name })} />
          ))}
        </View>
      ) : null}

      {notes.length ? <SectionHeader title="Note con attività" /> : null}
      {notes.length ? (
        <View style={st.card}>
          {notes.map((p) => (
            <Item key={p.file} icon="📝" label={p.name} count={p.open} onPress={() => onOpen({ kind: "project", file: p.file, name: p.name })} />
          ))}
        </View>
      ) : null}
      <Text style={st.hint}>Le attività delle note del giorno sono in «Oggi» e nel calendario.</Text>
    </ScrollView>
  );
}

export function TaskListScreen({ filter, onBack, onTask }: { filter: ListFilter; onBack: () => void; onTask: (t: VaultTask) => void }) {
  const a = useAgenda();
  const [showDone, setShowDone] = useState(false);
  const all = applyFilter(a.tasks, filter);
  const list = filter.kind === "project" && !showDone ? all.filter((t) => !t.done) : all;
  const doneCount = filter.kind === "project" ? all.filter((t) => t.done).length : 0;
  return (
    <View style={{ flex: 1 }}>
      <View style={st.nav}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={st.back}>‹ Progetti</Text>
        </Pressable>
      </View>
      <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 120 }}>
        <Text style={st.title}>{filterTitle(filter)}</Text>
        {list.length ? list.map((t) => <TaskRow key={t.id} task={t} showDate showProject={filter.kind !== "project"} onPress={() => onTask(t)} />) : <Empty text="Nessuna attività." />}
        {doneCount ? (
          <Pressable onPress={() => setShowDone(!showDone)} style={{ padding: 16 }}>
            <Text style={{ color: C.blue, fontSize: 15 }}>{showDone ? "Nascondi le completate" : `Mostra le completate (${doneCount})`}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  title: { fontSize: 32, fontWeight: "700", color: C.text, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  card: { backgroundColor: C.card, borderRadius: 12, marginHorizontal: 16, overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, gap: 12 },
  icon: { width: 22, textAlign: "center", fontSize: 17, color: C.sub },
  itemLabel: { flex: 1, fontSize: 17, color: C.text },
  count: { fontSize: 15, color: C.sub },
  hint: { fontSize: 13, color: C.sub, marginHorizontal: 32, marginTop: 6, lineHeight: 18 },
  nav: { paddingHorizontal: 16, paddingTop: 8 },
  back: { fontSize: 17, color: C.blue },
});
