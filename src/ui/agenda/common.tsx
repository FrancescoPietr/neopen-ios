// Building blocks of the calendar and task screens (Fantastical + Todoist style), UI in Italian.
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../theme/ui";
import { T, themed } from "../theme/theme";
import { HandBar, HandCheck, HandFrame, HandLine, RowLine } from "../theme/ui";
import { agenda, AgendaSnapshot, CalEvent } from "../../app/agenda";
import { Priority, VaultTask, addDays, parseYmd, ymd } from "../../core/tasks";

export const useAgenda = (): AgendaSnapshot => useSyncExternalStore(agenda.subscribe, agenda.getSnapshot);

/** Colors of the current look (read while drawing: they follow the "Aspetto" settings). */
export const C = {
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
  get faint() {
    return T.faint;
  },
  get line() {
    return T.line;
  },
  get blue() {
    return T.accent;
  },
  get red() {
    return T.red;
  },
  get green() {
    return T.green;
  },
  get accent() {
    return T.accent;
  },
};

export const PRIORITY_COLOR: Record<Priority, string> = { 1: "#D1453B", 2: "#EB8909", 3: "#246FE0", 4: "#8E8E93" };

export const today = () => ymd(new Date());

const WD = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const WD_LONG = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MO = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const MO_LONG = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

export const weekdayShort = (d: string) => WD[parseYmd(d).getDay()];
export const monthLong = (m: number) => MO_LONG[m];

/** "Oggi", "Domani", "Ieri", "ven 24 ott" (+ the year if not this year). */
export function dayLabel(d: string, long = false): string {
  const t = today();
  if (d === t) return "Oggi";
  if (d === addDays(t, 1)) return "Domani";
  if (d === addDays(t, -1)) return "Ieri";
  const x = parseYmd(d);
  const y = x.getFullYear() !== parseYmd(t).getFullYear() ? ` ${x.getFullYear()}` : "";
  return long ? `${WD_LONG[x.getDay()]} ${x.getDate()} ${MO_LONG[x.getMonth()]}${y}` : `${WD[x.getDay()]} ${x.getDate()} ${MO[x.getMonth()]}${y}`;
}

export const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// ---------------------------------------------------------------- rows

export function Check({ done, priority, onPress }: { done: boolean; priority: Priority; onPress: () => void }) {
  return <HandCheck done={done} color={priority < 4 ? PRIORITY_COLOR[priority] : T.inkSoft} onPress={onPress} />;
}

export function TaskRow({ task, onPress, showDate, showProject = false }: { task: VaultTask; onPress: () => void; showDate?: boolean; showProject?: boolean }) {
  const late = !task.done && task.date && task.date < today();
  const meta: string[] = [];
  if (showDate && task.date) meta.push(dayLabel(task.date));
  if (task.time) meta.push(task.end ? `${task.time}–${task.end}` : task.time);
  if (task.recurrence) meta.push("🔁");
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.taskRow, task.parent ? { paddingLeft: 44 } : null, pressed && { backgroundColor: C.line }]}>
      <Check done={task.done} priority={task.priority} onPress={() => void agenda.toggle(task)} />
      <View style={{ flex: 1 }}>
        <Text style={[s.taskTitle, task.done && s.doneText]} numberOfLines={3}>
          {task.title}
        </Text>
        <View style={s.metaRow}>
          {meta.length ? <Text style={[s.meta, late ? { color: C.red } : null]}>{meta.join(" · ")}</Text> : null}
          {task.labels.map((l) => (
            <Text key={l} style={s.label}>
              #{l}
            </Text>
          ))}
          {showProject ? <Text style={s.project}>{task.project}</Text> : null}
        </View>
      </View>
      <RowLine left={task.parent ? 44 : 16} />
    </Pressable>
  );
}

export function EventRow({ ev, onPress }: { ev: CalEvent; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.eventRow, pressed && { backgroundColor: C.line }]}>
      <HandBar color={ev.color} style={{ marginLeft: 12 }} />
      <View style={s.eventTime}>
        {ev.allDay ? (
          <Text style={s.eventTimeText}>tutto il giorno</Text>
        ) : (
          <>
            <Text style={s.eventTimeText}>{hm(ev.start)}</Text>
            <Text style={[s.eventTimeText, { color: C.faint }]}>{hm(ev.end)}</Text>
          </>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.taskTitle, /^\s*✓/.test(ev.title) ? { color: C.faint, textDecorationLine: "line-through" } : null]} numberOfLines={2}>
          {ev.title}
        </Text>
        {ev.location ? <Text style={s.meta}>{ev.location}</Text> : null}
      </View>
      <RowLine />
    </Pressable>
  );
}

export function SectionHeader({ title, right, color }: { title: string; right?: string; color?: string }) {
  return (
    <View style={s.sectionHeader}>
      <Text style={[s.sectionTitle, color ? { color } : null]}>{title}</Text>
      {right ? <Text style={s.sectionRight}>{right}</Text> : null}
    </View>
  );
}

/** Choices side by side; the chosen one is underlined with the pen. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.segmented}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={s.segment}>
          <Text style={[s.segmentText, value === o.value && s.segmentTextOn]}>{o.label}</Text>
          {value === o.value ? <HandLine color={C.accent} weight={2} seed={`seg${o.value}`} style={{ alignSelf: "stretch", marginHorizontal: 10 }} /> : <View style={{ height: 6 }} />}
        </Pressable>
      ))}
    </View>
  );
}

export function Chip({ label, on, onPress, color }: { label: string; on?: boolean; onPress: () => void; color?: string }) {
  const c = color ?? C.accent;
  return (
    <Pressable onPress={onPress}>
      <HandFrame style={s.chip} color={on ? c : C.line} weight={on ? 1.6 : 1} fill={on ? c + "26" : undefined} seed={`chip${label}`}>
        <Text style={[s.chipText, { color: on ? C.text : c }]}>{label}</Text>
      </HandFrame>
    </Pressable>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={s.empty}>{text}</Text>;
}

export const s = themed(() => StyleSheet.create({
  taskRow: { flexDirection: "row", gap: 12, paddingVertical: 11, paddingHorizontal: 16 },
  taskTitle: { fontSize: 17, color: C.text },
  doneText: { color: C.faint, textDecorationLine: "line-through" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 3, alignItems: "center" },
  meta: { fontSize: 13, color: C.sub },
  label: { fontSize: 13, color: C.accent },
  project: { fontSize: 13, color: C.faint, marginLeft: "auto" },
  eventRow: { flexDirection: "row", gap: 10, paddingVertical: 11, paddingRight: 16 },
  eventTime: { width: 58 },
  eventTimeText: { fontSize: 13, color: C.text, fontVariant: ["tabular-nums"] },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: C.text },
  sectionRight: { fontSize: 13, color: C.sub, marginLeft: "auto" },
  segmented: { flexDirection: "row", marginHorizontal: 16, marginVertical: 6 },
  segment: { flex: 1, paddingTop: 6, alignItems: "center" },
  segmentText: { fontSize: 16, color: C.sub },
  segmentTextOn: { color: C.text, fontWeight: "700" },
  chip: { paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: "500" },
  empty: { textAlign: "center", color: C.faint, paddingVertical: 24, fontSize: 15 },
}));
