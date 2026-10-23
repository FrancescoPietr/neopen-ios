// Building blocks of the calendar and task screens (Fantastical + Todoist style), UI in Italian.
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { agenda, AgendaSnapshot, CalEvent } from "../../app/agenda";
import { Priority, VaultTask, addDays, parseYmd, ymd } from "../../core/tasks";

export const useAgenda = (): AgendaSnapshot => useSyncExternalStore(agenda.subscribe, agenda.getSnapshot);

export const C = {
  bg: "#F2F2F7",
  card: "#FFFFFF",
  text: "#1C1C1E",
  sub: "#6C6C70",
  faint: "#AEAEB2",
  line: "#E5E5EA",
  blue: "#0A63D6",
  red: "#D12F2F",
  green: "#1E9E4A",
  accent: "#E5484D",
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
  const color = PRIORITY_COLOR[priority];
  return (
    <Pressable onPress={onPress} hitSlop={10} style={[s.check, { borderColor: color, backgroundColor: done ? color : priority < 4 ? color + "1A" : "transparent" }]}>
      {done ? <Text style={s.checkMark}>✓</Text> : null}
    </Pressable>
  );
}

export function TaskRow({ task, onPress, showDate, showProject = true }: { task: VaultTask; onPress: () => void; showDate?: boolean; showProject?: boolean }) {
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
    </Pressable>
  );
}

export function EventRow({ ev, onPress }: { ev: CalEvent; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.eventRow, pressed && { backgroundColor: C.line }]}>
      <View style={[s.eventBar, { backgroundColor: ev.color }]} />
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
        <Text style={s.taskTitle} numberOfLines={2}>
          {ev.title}
        </Text>
        {ev.location ? <Text style={s.meta}>{ev.location}</Text> : null}
      </View>
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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.segmented}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.segment, value === o.value && s.segmentOn]}>
          <Text style={[s.segmentText, value === o.value && s.segmentTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Chip({ label, on, onPress, color = C.blue }: { label: string; on?: boolean; onPress: () => void; color?: string }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, on ? { backgroundColor: color, borderColor: color } : null]}>
      <Text style={[s.chipText, on ? { color: "#fff" } : { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={s.empty}>{text}</Text>;
}

export const s = StyleSheet.create({
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center", marginTop: 1 },
  checkMark: { color: "#fff", fontSize: 13, fontWeight: "700" },
  taskRow: { flexDirection: "row", gap: 12, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: C.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  taskTitle: { fontSize: 16, color: C.text },
  doneText: { color: C.faint, textDecorationLine: "line-through" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 3, alignItems: "center" },
  meta: { fontSize: 13, color: C.sub },
  label: { fontSize: 13, color: "#8E44AD" },
  project: { fontSize: 13, color: C.faint, marginLeft: "auto" },
  eventRow: { flexDirection: "row", gap: 10, paddingVertical: 10, paddingRight: 16, backgroundColor: C.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  eventBar: { width: 4, borderRadius: 2, marginLeft: 12 },
  eventTime: { width: 58 },
  eventTimeText: { fontSize: 13, color: C.text, fontVariant: ["tabular-nums"] },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6, backgroundColor: C.bg },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: C.text },
  sectionRight: { fontSize: 13, color: C.sub, marginLeft: "auto" },
  segmented: { flexDirection: "row", backgroundColor: "#E3E3E8", borderRadius: 9, padding: 2, marginHorizontal: 16, marginVertical: 8 },
  segment: { flex: 1, paddingVertical: 6, borderRadius: 7, alignItems: "center" },
  segmentOn: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  segmentText: { fontSize: 13, color: C.sub, fontWeight: "500" },
  segmentTextOn: { color: C.text, fontWeight: "600" },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.card },
  chipText: { fontSize: 13, fontWeight: "500" },
  empty: { textAlign: "center", color: C.faint, paddingVertical: 24, fontSize: 15 },
});
