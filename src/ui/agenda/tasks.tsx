// "Attività" (Todoist): only tasks: late, today, the next days, later, without a date.
// Filters (priority, without a date, added in the app, done, labels) in a menu.
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Glyph, HandFrame, SPACE, Text } from "../theme/ui";
import { themed } from "../theme/theme";
import { agenda, isAppTask } from "../../app/agenda";
import { byDateTime, labels, overdue } from "../../core/taskStore";
import { Priority, VaultTask, addDays, parseYmd } from "../../core/tasks";
import { C, Empty, PRIORITY_COLOR, SectionHeader, TaskRow, today, useAgenda } from "./common";

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
  // quello che è già fatto oggi non resta in mezzo: si apre a richiesta
  const [showDone, setShowDone] = useState(false);
  const doneToday = todays.filter((x) => x.done);
  const openToday = todays.filter((x) => !x.done);
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
      {openToday.length ? openToday.map((x) => <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />) : <Text style={st.free}>{doneToday.length ? "Tutto fatto per oggi." : "Niente per oggi."}</Text>}
      {doneToday.length ? (
        <Pressable onPress={() => setShowDone(!showDone)} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ flex: 1, color: C.sub }}>{doneToday.length === 1 ? "1 fatta" : `${doneToday.length} fatte`}</Text>
          <Glyph name={showDone ? "nav.down" : "nav.next"} size={14} color={C.sub} />
        </Pressable>
      ) : null}
      {showDone ? doneToday.map((x) => <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />) : null}

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
        <Pressable onPress={() => setShowUndated(!showUndated)} style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}>
            <SectionHeader title="Senza data" right={String(undated.length)} />
          </View>
          <Glyph name={showUndated ? "nav.down" : "nav.next"} size={14} color={C.sub} style={{ marginRight: 16, marginBottom: 8 }} />
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

// ---------------------------------------------------------------- filters (in a menu)

type Filter = { kind: "all" } | { kind: "priority"; p: Priority } | { kind: "nodate" } | { kind: "app" } | { kind: "done" } | { kind: "label"; name: string };

const filterName = (f: Filter): string =>
  f.kind === "all" ? "Tutte" : f.kind === "priority" ? `Priorità ${f.p}` : f.kind === "nodate" ? "Senza data" : f.kind === "app" ? "Aggiunte nell'app" : f.kind === "done" ? "Completate" : `#${f.name}`;

function applyFilter(tasks: VaultTask[], f: Filter): VaultTask[] {
  switch (f.kind) {
    case "priority":
      return tasks.filter((t) => !t.done && t.priority === f.p).sort(byDateTime);
    case "nodate":
      return tasks.filter((t) => !t.done && !t.date).sort(byDateTime);
    case "app":
      return tasks.filter((t) => !t.done && isAppTask(t)).sort(byDateTime);
    case "done":
      return tasks.filter((t) => t.done).sort((x, y) => (y.doneDate ?? "").localeCompare(x.doneDate ?? "")).slice(0, 150);
    case "label":
      return tasks.filter((t) => !t.done && t.labels.includes(f.name)).sort(byDateTime);
    default:
      return tasks;
  }
}

function FilterMenu({ value, onPick, onClose }: { value: Filter; onPick: (f: Filter) => void; onClose: () => void }) {
  const a = useAgenda();
  const open = a.tasks.filter((t) => !t.done);
  const items: { f: Filter; icon: string; color?: string; count?: number }[] = [
    { f: { kind: "all" }, icon: "tab.tasks" },
    ...([1, 2, 3] as Priority[]).map((p) => ({ f: { kind: "priority", p } as Filter, icon: "priority", color: PRIORITY_COLOR[p], count: open.filter((t) => t.priority === p).length })),
    { f: { kind: "nodate" }, icon: "nodate", count: open.filter((t) => !t.date).length },
    { f: { kind: "app" }, icon: "add", count: open.filter(isAppTask).length },
    { f: { kind: "done" }, icon: "completed", color: C.green },
    ...labels(a.tasks).map((l) => ({ f: { kind: "label", name: l.name } as Filter, icon: "label", count: l.open })),
  ];
  return (
    <>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <HandFrame style={st.menu} fill={C.bg} color={C.text} weight={1.2} seed="menu">
        <ScrollView style={{ maxHeight: 420 }}>
          {items.map(({ f, icon, color, count }) => {
            const on = filterName(f) === filterName(value);
            return (
              <Pressable key={filterName(f)} onPress={() => onPick(f)} style={({ pressed }) => [st.menuItem, pressed && { backgroundColor: C.line }]}>
                <Glyph name={icon} size={18} color={color ?? C.sub} />
                <Text style={[st.menuText, on && { fontWeight: "700", color: C.accent }]}>{filterName(f)}</Text>
                {count ? <Text style={st.menuCount}>{count}</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </HandFrame>
    </>
  );
}

export function TasksScreen({ onTask }: { onTask: (t: VaultTask) => void }) {
  const a = useAgenda();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [menu, setMenu] = useState(false);
  const list = filter.kind === "all" ? [] : applyFilter(a.tasks, filter);
  return (
    <View style={{ flex: 1 }}>
      <View style={st.head}>
        <Text style={st.title} numberOfLines={1}>
          Attività
        </Text>
        <Pressable onPress={() => setMenu(!menu)} hitSlop={10}>
          <HandFrame style={st.filterBtn} color={filter.kind === "all" ? C.line : C.accent} seed="filtro">
            <Glyph name="filter" size={16} color={filter.kind === "all" ? C.sub : C.accent} />
            <Text style={[st.filterText, filter.kind !== "all" && { color: C.accent }]}>Filtri</Text>
          </HandFrame>
        </Pressable>
      </View>
      {filter.kind !== "all" ? (
        <View style={st.activeRow}>
          <Pressable onPress={() => setFilter({ kind: "all" })} hitSlop={6}>
            <HandFrame style={st.activeChip} color={C.accent} fill={C.accent + "22"} seed="attivo">
              <Text style={st.activeText}>{filterName(filter)}</Text>
              <Glyph name="close" size={11} color={C.accent} weight={1.3} />
            </HandFrame>
          </Pressable>
        </View>
      ) : null}
      <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 140 }}>
        {filter.kind === "all" ? <Planned onTask={onTask} /> : list.length ? list.map((x) => <TaskRow key={x.id} task={x} showDate onPress={() => onTask(x)} />) : <Empty text="Nessuna attività." />}
      </ScrollView>
      {menu ? (
        <FilterMenu
          value={filter}
          onClose={() => setMenu(false)}
          onPick={(f) => {
            setFilter(f);
            setMenu(false);
          }}
        />
      ) : null}
    </View>
  );
}

const st = themed(() => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: SPACE.gap * 2, paddingHorizontal: SPACE.side, paddingTop: SPACE.gap, paddingBottom: SPACE.gap },
  title: { flex: 1, fontSize: 36, fontWeight: "700", color: C.text },
  filterBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7 },
  filterText: { fontSize: 16, color: C.sub },
  activeRow: { flexDirection: "row", paddingHorizontal: SPACE.side, paddingBottom: SPACE.gap },
  activeChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 5 },
  activeText: { fontSize: 15, color: C.accent },
  menu: { position: "absolute", top: 62, right: SPACE.side, width: 240, paddingVertical: 4 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  menuText: { flex: 1, fontSize: 16, color: C.text },
  menuCount: { fontSize: 14, color: C.sub },
  free: { color: C.faint, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16 },
}));
