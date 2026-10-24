// "Calendario": day, week and month, with events (iPhone calendars) and dated tasks (vault).
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { ScrollViewInstance } from "react-native";
import { agenda, CalEvent, visibleEvents } from "../../app/agenda";
import { onDay } from "../../core/taskStore";
import { VaultTask, addDays, parseYmd, ymd } from "../../core/tasks";
import { C, Check, PRIORITY_COLOR, Segmented, hm, monthLong, today, useAgenda } from "./common";
import { DayAgenda } from "./today";

type Mode = "day" | "week" | "month";
const HOUR = 52;

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const tMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Monday of the week of `d`. */
function weekStart(d: string): string {
  const wd = (parseYmd(d).getDay() + 6) % 7;
  return addDays(d, -wd);
}

interface Block {
  key: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  title: string;
  color: string;
  ev?: CalEvent;
  task?: VaultTask;
  time: string;
}

/** Timed events and tasks of a day, laid out side by side when they overlap. */
function layout(day: string, events: CalEvent[], tasks: VaultTask[]): Block[] {
  const items: Omit<Block, "col" | "cols">[] = [];
  for (const e of events) {
    if (e.allDay) continue;
    const startsToday = ymd(e.start) === day;
    const endsToday = ymd(e.end) === day;
    const a = startsToday ? minutesOf(e.start) : 0;
    const b = endsToday ? Math.max(a + 20, minutesOf(e.end)) : 24 * 60;
    items.push({ key: `e${e.id}${e.start.getTime()}`, top: (a / 60) * HOUR, height: Math.max(22, ((b - a) / 60) * HOUR - 2), title: e.title, color: e.color, ev: e, time: hm(e.start) });
  }
  for (const t of tasks) {
    if (!t.time) continue;
    const a = tMin(t.time);
    const b = t.end ? Math.max(a + 20, tMin(t.end)) : a + 30;
    items.push({ key: `t${t.id}`, top: (a / 60) * HOUR, height: Math.max(22, ((b - a) / 60) * HOUR - 2), title: t.title, color: PRIORITY_COLOR[t.priority], task: t, time: t.time });
  }
  items.sort((x, y) => x.top - y.top);
  const out: Block[] = [];
  let group: Block[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) out.push({ ...g, cols });
    group = [];
  };
  for (const it of items) {
    if (it.top >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    const used = new Set(group.filter((g) => g.top + g.height > it.top).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ ...it, col, cols: 1 });
    groupEnd = Math.max(groupEnd, it.top + it.height);
  }
  flush();
  return out;
}

function HourGrid({ days, onTask, onEvent, compact }: { days: string[]; onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void; compact?: boolean }) {
  const a = useAgenda();
  const { width } = useWindowDimensions();
  const gutter = 44;
  const colW = (width - gutter) / days.length;
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    const now = new Date();
    scroll.current?.scrollTo({ y: Math.max(0, (now.getHours() - 1.5) * HOUR), animated: false });
  }, []);
  const t = today();
  const now = new Date();
  return (
    <View style={{ flex: 1 }}>
      {/* all day: events and tasks without a time */}
      <View style={[st.allDay, { paddingLeft: gutter }]}>
        {days.map((d) => {
          const evs = visibleEvents(a, d).filter((e) => e.allDay);
          const tasks = onDay(a.tasks, d).filter((x) => !x.time);
          return (
            <View key={d} style={{ width: colW, paddingHorizontal: 1, gap: 2 }}>
              {evs.map((e) => (
                <Pressable key={e.id} onPress={() => onEvent(e)} style={[st.allDayItem, { backgroundColor: e.color + "33", borderLeftColor: e.color }]}>
                  <Text numberOfLines={1} style={st.blockText}>
                    {e.title}
                  </Text>
                </Pressable>
              ))}
              {tasks.slice(0, compact ? 3 : 8).map((x) => (
                <Pressable key={x.id} onPress={() => onTask(x)} style={st.allDayTask}>
                  {!compact ? <Check done={x.done} priority={x.priority} onPress={() => void agenda.toggle(x)} /> : null}
                  <Text numberOfLines={1} style={[st.blockText, { flex: 1 }, x.done && { color: C.faint, textDecorationLine: "line-through" }]}>
                    {compact ? (x.done ? "✓ " : "○ ") : ""}
                    {x.title}
                  </Text>
                </Pressable>
              ))}
              {compact && tasks.length > 3 ? <Text style={st.more}>+{tasks.length - 3}</Text> : null}
            </View>
          );
        })}
      </View>
      <ScrollView ref={scroll} contentContainerStyle={{ height: HOUR * 24 + 20 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <View key={h} style={[st.hourRow, { top: h * HOUR }]}>
            <Text style={st.hourText}>{h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}</Text>
            <View style={st.hourLine} />
          </View>
        ))}
        {days.map((d, i) => (
          <View key={d} style={{ position: "absolute", left: gutter + i * colW, width: colW, top: 0, height: HOUR * 24, borderLeftWidth: days.length > 1 ? StyleSheet.hairlineWidth : 0, borderLeftColor: C.line }}>
            {layout(d, visibleEvents(a, d), onDay(a.tasks, d)).map((b) => (
              <Pressable
                key={b.key}
                onPress={() => (b.ev ? onEvent(b.ev) : b.task ? onTask(b.task) : undefined)}
                style={[
                  st.block,
                  {
                    top: b.top,
                    height: b.height,
                    left: (b.col * (colW - 2)) / b.cols + 1,
                    width: (colW - 2) / b.cols - 1,
                    backgroundColor: b.ev ? b.color + "33" : "#fff",
                    borderLeftColor: b.color,
                    borderStyle: b.task ? "dashed" : "solid",
                    borderWidth: b.task ? 1 : 0,
                    borderColor: b.color,
                  },
                ]}
              >
                <Text numberOfLines={compact ? 3 : 2} style={[st.blockText, b.task?.done && { textDecorationLine: "line-through", color: C.faint }]}>
                  {b.task ? (b.task.done ? "✓ " : "○ ") : ""}
                  {b.title}
                </Text>
                {!compact && b.height > 36 ? <Text style={st.blockTime}>{b.time}</Text> : null}
              </Pressable>
            ))}
            {d === t ? <View style={[st.nowLine, { top: (minutesOf(now) / 60) * HOUR }]} /> : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function MonthGrid({ month, selected, onSelect }: { month: Date; selected: string; onSelect: (d: string) => void }) {
  const a = useAgenda();
  const first = ymd(new Date(month.getFullYear(), month.getMonth(), 1));
  const start = weekStart(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const t = today();
  return (
    <View>
      <View style={st.monthHead}>
        {["lun", "mar", "mer", "gio", "ven", "sab", "dom"].map((w) => (
          <Text key={w} style={st.monthHeadText}>
            {w}
          </Text>
        ))}
      </View>
      <View style={st.monthGrid}>
        {days.map((d) => {
          const inMonth = parseYmd(d).getMonth() === month.getMonth();
          const evs = visibleEvents(a, d);
          const tasks = a.tasks.filter((x) => x.date === d && !x.done).length;
          const on = d === selected;
          return (
            <Pressable key={d} onPress={() => onSelect(d)} style={st.monthCell}>
              <View style={[st.monthNum, on && { backgroundColor: d === t ? C.accent : C.text }]}>
                <Text style={[st.monthNumText, !inMonth && { color: C.faint }, d === t && !on && { color: C.accent, fontWeight: "700" }, on && { color: "#fff" }]}>{parseYmd(d).getDate()}</Text>
              </View>
              <View style={st.monthDots}>
                {evs.slice(0, 3).map((e, i) => (
                  <View key={i} style={[st.mdot, { backgroundColor: e.color }]} />
                ))}
                {tasks ? <View style={[st.mdot, { backgroundColor: "transparent", borderWidth: 1, borderColor: C.sub }]} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function CalendarScreen({ onTask, onEvent, onDayChange }: { onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void; onDayChange: (d: string) => void }) {
  const a = useAgenda();
  const [mode, setMode] = useState<Mode>("week");
  const [day, setDay] = useState(today());
  useEffect(() => onDayChange(day), [day]);
  const month = useMemo(() => new Date(parseYmd(day).getFullYear(), parseYmd(day).getMonth(), 1), [day]);
  const days = mode === "day" ? [day] : Array.from({ length: 7 }, (_, i) => addDays(weekStart(day), i));

  useEffect(() => {
    if (mode === "month") {
      const s = weekStart(ymd(month));
      void agenda.loadEvents(parseYmd(s), parseYmd(addDays(s, 42)));
    } else void agenda.loadEvents(parseYmd(days[0]), parseYmd(days[days.length - 1]));
  }, [mode, day, a.calendarAccess, a.calendars.length, Object.keys(a.events).length === 0]);

  const step = (n: number) => {
    if (mode === "day") setDay(addDays(day, n));
    else if (mode === "week") setDay(addDays(day, 7 * n));
    else setDay(ymd(new Date(month.getFullYear(), month.getMonth() + n, 1)));
  };
  const title =
    mode === "month" || mode === "week"
      ? `${monthLong(parseYmd(days[mode === "week" ? 3 : 0] ?? day).getMonth())} ${parseYmd(mode === "week" ? days[3] : day).getFullYear()}`
      : `${parseYmd(day).getDate()} ${monthLong(parseYmd(day).getMonth())}`;

  return (
    <View style={{ flex: 1 }}>
      <View style={st.nav}>
        <Pressable onPress={() => step(-1)} hitSlop={12}>
          <Text style={st.arrow}>‹</Text>
        </Pressable>
        <Text style={st.navTitle}>{title.replace(/^\w/, (c) => c.toUpperCase())}</Text>
        <Pressable onPress={() => step(1)} hitSlop={12}>
          <Text style={st.arrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => setDay(today())} style={st.todayBtn}>
          <Text style={st.todayText}>Oggi</Text>
        </Pressable>
      </View>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "day", label: "Giorno" },
          { value: "week", label: "Settimana" },
          { value: "month", label: "Mese" },
        ]}
      />
      {a.calendarAccess !== "granted" ? (
        <Pressable onPress={() => void agenda.initCalendar(true)} style={st.banner}>
          <Text style={st.bannerText}>{a.calendarAccess === "denied" ? "Accesso ai calendari negato: Impostazioni di iPhone → NeoTransfer → Calendari → Accesso completo." : "Tocca qui per mostrare i calendari dell'iPhone (Google, iCloud…)."}</Text>
        </Pressable>
      ) : null}
      {mode === "week" ? (
        <View style={[st.weekHead, { paddingLeft: 44 }]}>
          {days.map((d) => (
            <Pressable key={d} style={{ flex: 1, alignItems: "center" }} onPress={() => (setDay(d), setMode("day"))}>
              <Text style={[st.weekWd, d === today() && { color: C.accent }]}>{["dom", "lun", "mar", "mer", "gio", "ven", "sab"][parseYmd(d).getDay()]}</Text>
              <Text style={[st.weekNum, d === today() && { color: C.accent }]}>{parseYmd(d).getDate()}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {mode === "month" ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
          <MonthGrid month={month} selected={day} onSelect={setDay} />
          <DayAgenda day={day} onTask={onTask} onEvent={onEvent} />
        </ScrollView>
      ) : (
        <HourGrid days={days} onTask={onTask} onEvent={onEvent} compact={mode === "week"} />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  nav: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  arrow: { fontSize: 30, color: C.accent, lineHeight: 32 },
  navTitle: { fontSize: 24, fontWeight: "700", color: C.text, flex: 1, textAlign: "center" },
  todayBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: C.accent },
  todayText: { color: C.accent, fontWeight: "600", fontSize: 13 },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, backgroundColor: "#FFF4E5" },
  bannerText: { color: "#8A4B00", fontSize: 14 },
  weekHead: { flexDirection: "row", paddingBottom: 4 },
  weekWd: { fontSize: 11, color: C.sub, textTransform: "uppercase" },
  weekNum: { fontSize: 17, fontWeight: "600", color: C.text },
  allDay: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, paddingVertical: 4, backgroundColor: C.card, minHeight: 8 },
  allDayItem: { borderLeftWidth: 3, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2 },
  allDayTask: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingVertical: 2 },
  more: { fontSize: 11, color: C.sub, paddingHorizontal: 4 },
  hourRow: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", height: 1 },
  hourText: { width: 44, fontSize: 11, color: C.faint, textAlign: "right", paddingRight: 6, marginTop: -1 },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.line },
  block: { position: "absolute", borderLeftWidth: 3, borderRadius: 5, paddingHorizontal: 4, paddingVertical: 2, overflow: "hidden" },
  blockText: { fontSize: 12, color: C.text, fontWeight: "500" },
  blockTime: { fontSize: 11, color: C.sub },
  nowLine: { position: "absolute", left: 0, right: 0, height: 2, backgroundColor: C.accent },
  monthHead: { flexDirection: "row", paddingHorizontal: 8 },
  monthHeadText: { flex: 1, textAlign: "center", fontSize: 12, color: C.sub, textTransform: "uppercase" },
  monthGrid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8 },
  monthCell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 6 },
  monthNum: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  monthNumText: { fontSize: 16, color: C.text },
  monthDots: { flexDirection: "row", gap: 2, height: 6, marginTop: 2 },
  mdot: { width: 5, height: 5, borderRadius: 3 },
});
