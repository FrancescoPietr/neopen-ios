// "Progetti" (Todoist): Inbox, projects, notes with tasks, labels and priorities; each opens its task list.
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Glyph, HandFrame, RowLine, Text } from "../theme/ui";
import { themed } from "../theme/theme";
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
      <Glyph name={icon} size={20} color={color ?? C.sub} />
      <Text style={st.itemLabel} numberOfLines={1}>
        {label}
      </Text>
      {count ? <Text style={st.count}>{count}</Text> : null}
      <RowLine left={48} />
    </Pressable>
  );
}

export function ProjectsScreen({ onOpen, showTitle = true }: { onOpen: (f: ListFilter) => void; showTitle?: boolean }) {
  const a = useAgenda();
  const ps = projects(a.tasks);
  const own = ps.filter((p) => p.own);
  const notes = ps.filter((p) => !p.own);
  const ls = labels(a.tasks);
  const open = a.tasks.filter((t) => !t.done);
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 120 }}>
      {showTitle ? <Text style={st.title}>Progetti</Text> : null}
      <HandFrame style={st.card}>
        {(own.length ? own : [{ name: "Inbox", file: "Attività/Inbox.md", open: 0, own: true }]).map((p) => (
          <Item key={p.file} icon={p.name === "Inbox" ? "inbox" : "project"} color={p.name === "Inbox" ? undefined : C.accent} label={p.name} count={p.open} onPress={() => onOpen({ kind: "project", file: p.file, name: p.name })} />
        ))}
      </HandFrame>
      <Text style={st.hint}>Un progetto è una nota nella cartella «Attività» del vault. Per crearne uno, scrivi +Nome nell'aggiunta rapida.</Text>

      <SectionHeader title="Filtri" />
      <HandFrame style={st.card}>
        {([1, 2, 3] as Priority[]).map((p) => (
          <Item key={p} icon="priority" color={PRIORITY_COLOR[p]} label={`Priorità ${p}`} count={open.filter((t) => t.priority === p).length} onPress={() => onOpen({ kind: "priority", p })} />
        ))}
        <Item icon="nodate" label="Senza data" count={open.filter((t) => !t.date).length} onPress={() => onOpen({ kind: "nodate" })} />
        <Item icon="completed" color={C.green} label="Completate" onPress={() => onOpen({ kind: "done" })} />
      </HandFrame>

      {ls.length ? <SectionHeader title="Etichette" /> : null}
      {ls.length ? (
        <HandFrame style={st.card}>
          {ls.map((l) => (
            <Item key={l.name} icon="label" label={l.name} count={l.open} onPress={() => onOpen({ kind: "label", name: l.name })} />
          ))}
        </HandFrame>
      ) : null}

      {notes.length ? <SectionHeader title="Note con attività" /> : null}
      {notes.length ? (
        <HandFrame style={st.card}>
          {notes.map((p) => (
            <Item key={p.file} icon="note" label={p.name} count={p.open} onPress={() => onOpen({ kind: "project", file: p.file, name: p.name })} />
          ))}
        </HandFrame>
      ) : null}
      <Text style={st.hint}>Le attività delle note del giorno sono in «In programma» e nel calendario.</Text>
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
        <Pressable onPress={onBack} hitSlop={12} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Glyph name="nav.back" size={18} color={C.accent} weight={1.2} />
          <Text style={st.back}>Progetti</Text>
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

const st = themed(() => StyleSheet.create({
  title: { fontSize: 36, fontWeight: "700", color: C.text, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  card: { marginHorizontal: 12, paddingVertical: 4 },
  item: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  itemLabel: { flex: 1, fontSize: 18, color: C.text },
  count: { fontSize: 15, color: C.sub },
  hint: { fontSize: 13, color: C.sub, marginHorizontal: 32, marginTop: 6, lineHeight: 18 },
  nav: { paddingHorizontal: 16, paddingTop: 8 },
  back: { fontSize: 18, color: C.accent },
}));
