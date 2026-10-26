// "Calendario": the whole month on one screen, a dot under the days with something on (events of the iPhone
// calendars, tasks of the vault). Tap a day → that day: all-day events, then the timeline (events and tasks with a
// time, in order), then the tasks of the day. Swipe left/right to change month or day.
import { useEffect, useRef, useState } from "react";
import { GestureResponderEvent, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { BackBar, Dot, Glyph, HandBar, HandFrame, HandLine, HandRing, NowMark, RowLine, Text } from "../theme/ui";
import { themed } from "../theme/theme";
import { agenda, CalEvent, visibleEvents } from "../../app/agenda";
import { onDay } from "../../core/taskStore";
import { VaultTask, addDays, parseYmd, ymd } from "../../core/tasks";
import { C, Check, Empty, PRIORITY_COLOR, SectionHeader, TaskRow, dayLabel, hm, monthLong, today, useAgenda } from "./common";

const WEEK = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
const WD_LONG = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const cap = (x: string) => x.replace(/^\p{L}/u, (c) => c.toUpperCase());

/** Monday of the week of `d`. */
function weekStart(d: string): string {
  return addDays(d, -((parseYmd(d).getDay() + 6) % 7));
}

/** Loads the events of the days from..to (again when the calendar changes). */
function useEvents(from: string, to: string) {
  const a = useAgenda();
  useEffect(() => {
    void agenda.loadEvents(parseYmd(from), parseYmd(to));
  }, [from, to, a.eventsEpoch, a.calendarAccess, a.calendars.length]);
}

/** Horizontal swipe (left = next, right = previous); taps are left alone. */
function useSwipe(onPrev: () => void, onNext: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: GestureResponderEvent) => {
      start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dx = e.nativeEvent.pageX - s.x;
      const dy = e.nativeEvent.pageY - s.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) (dx < 0 ? onNext : onPrev)();
    },
  };
}

function CalendarAccess() {
  const a = useAgenda();
  if (a.calendarAccess === "granted") return null;
  return (
    <Pressable onPress={() => void agenda.initCalendar(true)} style={st.banner}>
      <Text style={st.bannerText}>
        {a.calendarAccess === "denied"
          ? "Accesso ai calendari negato: Impostazioni di iPhone → NeoTransfer → Calendari → Accesso completo."
          : "Tocca qui per mostrare i calendari dell'iPhone (Google, iCloud…)."}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- month

function MonthScreen({ month, onMonth, onOpen, onAdd }: { month: string; onMonth: (m: string) => void; onOpen: (d: string) => void; onAdd: () => void }) {
  const a = useAgenda();
  const m = parseYmd(month);
  const first = ymd(new Date(m.getFullYear(), m.getMonth(), 1));
  const last = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 0));
  const start = weekStart(first);
  const rows = Math.ceil((((parseYmd(first).getDay() + 6) % 7) + parseYmd(last).getDate()) / 7);
  const days = Array.from({ length: rows * 7 }, (_, i) => addDays(start, i));
  useEvents(days[0], days[days.length - 1]);
  const [height, setHeight] = useState(0);
  const go = (n: number) => onMonth(ymd(new Date(m.getFullYear(), m.getMonth() + n, 1)));
  const swipe = useSwipe(() => go(-1), () => go(1));
  const t = today();
  const thisMonth = month === ymd(new Date(parseYmd(t).getFullYear(), parseYmd(t).getMonth(), 1));

  return (
    <View style={{ flex: 1 }}>
      <View style={st.nav}>
        <Pressable onPress={() => go(-1)} hitSlop={14}>
          <Glyph name="nav.prev" size={26} color={C.accent} weight={1.2} />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={st.monthTitle}>{cap(monthLong(m.getMonth()))}</Text>
          <Text style={st.year}>{m.getFullYear()}</Text>
        </View>
        <Pressable onPress={() => go(1)} hitSlop={14}>
          <Glyph name="nav.next" size={26} color={C.accent} weight={1.2} />
        </Pressable>
      </View>
      <View style={st.tools}>
        <Pressable onPress={() => onMonth(ymd(new Date(parseYmd(t).getFullYear(), parseYmd(t).getMonth(), 1)))} disabled={thisMonth} style={thisMonth && { opacity: 0.35 }}>
          <HandFrame style={st.pill} color={C.accent} seed="oggi">
            <Text style={st.pillText}>Oggi</Text>
          </HandFrame>
        </Pressable>
        <Pressable onPress={onAdd}>
          <HandFrame style={[st.pill, { flexDirection: "row", alignItems: "center", gap: 6 }]} color={C.accent} fill={C.accent + "2E"} weight={1.4} seed="nuovo">
            <Glyph name="add" size={14} color={C.accent} weight={1.4} />
            <Text style={st.pillText}>Nuovo</Text>
          </HandFrame>
        </Pressable>
      </View>
      <CalendarAccess />
      <View style={st.weekHead}>
        <HandLine style={{ position: "absolute", left: 4, right: 4, bottom: -3 }} seed="head" />
        {WEEK.map((w, i) => (
          <Text key={w} style={[st.weekHeadText, i >= 5 && { color: C.accent }]}>
            {w}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1 }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)} {...swipe}>
        {height > 0
          ? Array.from({ length: rows }, (_, r) => (
              <View key={r} style={[st.weekRow, { height: (height - 4) / rows }]}>
                <HandLine style={{ position: "absolute", left: 4, right: 4, bottom: -3 }} seed={`w${r}`} />
                {days.slice(r * 7, r * 7 + 7).map((d) => {
                  const inMonth = parseYmd(d).getMonth() === m.getMonth();
                  const items = preview(d, visibleEvents(a, d), onDay(a.tasks, d));
                  const fit = Math.max(1, Math.floor(((height - 4) / rows - 38) / 14));
                  const shown = items.length > fit ? items.slice(0, fit - 1) : items;
                  const isToday = d === t;
                  return (
                    <Pressable key={d} onPress={() => onOpen(d)} style={({ pressed }) => [st.cell, pressed && { backgroundColor: C.line }]}>
                      <View style={st.num}>
                        {isToday ? <HandRing size={32} /> : null}
                        <Text style={[st.numText, !inMonth && { color: C.faint }, isToday && { color: C.accent, fontWeight: "700" }]}>{parseYmd(d).getDate()}</Text>
                      </View>
                      <View style={st.previews}>
                        {shown.map((x) => (
                          <Text
                            key={x.key}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[st.pv, { color: inMonth ? (x.event ? C.text : x.color) : C.faint }, x.event && inMonth && { backgroundColor: x.color + "33" }, x.done && st.pvDone]}
                          >
                            {x.title}
                          </Text>
                        ))}
                        {items.length > shown.length ? <Text style={st.pvMore}>+{items.length - shown.length}</Text> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))
          : null}
      </View>
    </View>
  );
}

/** What a day of the month shows: all-day events, then events and tasks by time, then the other tasks. */
function preview(day: string, events: CalEvent[], tasks: VaultTask[]): { key: string; title: string; color: string; done: boolean; event: boolean }[] {
  const allDay = events.filter((e) => e.allDay).map((e) => ({ key: `a${e.id}`, title: e.title.replace(/^\s*✓\s*/, ""), color: e.color, done: /^\s*✓/.test(e.title), event: true }));
  const timed = timeline(day, events, tasks).map((x) => ({ key: x.key, title: x.title.replace(/^\s*✓\s*/, ""), color: x.ev ? x.color : C.text, done: x.task ? x.task.done : /^\s*✓/.test(x.title), event: !!x.ev }));
  const rest = tasks.filter((x) => !x.time).map((x) => ({ key: `t${x.id}`, title: x.title, color: C.text, done: x.done, event: false }));
  // what is done goes last (and is struck through)
  return [...allDay, ...timed, ...rest].sort((p, q) => Number(p.done) - Number(q.done));
}

// ---------------------------------------------------------------- day

interface Timed {
  key: string;
  min: number;
  from: string;
  to: string;
  title: string;
  color: string;
  ev?: CalEvent;
  task?: VaultTask;
}

const tMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function timeline(day: string, events: CalEvent[], tasks: VaultTask[]): Timed[] {
  const out: Timed[] = [];
  for (const e of events) {
    if (e.allDay) continue;
    const starts = ymd(e.start) === day;
    const ends = ymd(e.end) === day;
    out.push({
      key: `e${e.id}${e.start.getTime()}`,
      min: starts ? e.start.getHours() * 60 + e.start.getMinutes() : 0,
      from: starts ? hm(e.start) : "…",
      to: ends ? hm(e.end) : "…",
      title: e.title,
      color: e.color,
      ev: e,
    });
  }
  for (const t of tasks) {
    if (!t.time) continue;
    out.push({ key: `t${t.id}`, min: tMin(t.time), from: t.time, to: t.end ?? "", title: t.title, color: PRIORITY_COLOR[t.priority], task: t });
  }
  return out.sort((x, y) => x.min - y.min || x.title.localeCompare(y.title));
}

function TimedRow({ item, onTask, onEvent }: { item: Timed; onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void }) {
  const done = item.task ? item.task.done : /^\s*✓/.test(item.title);
  return (
    <Pressable onPress={() => (item.ev ? onEvent(item.ev) : item.task ? onTask(item.task) : undefined)} style={({ pressed }) => [st.timed, pressed && { backgroundColor: C.line }]}>
      <View style={st.time}>
        <Text style={st.timeFrom}>{item.from}</Text>
        {item.to ? <Text style={st.timeTo}>{item.to}</Text> : null}
      </View>
      <HandBar color={item.color} />
      {item.task ? <Check done={item.task.done} priority={item.task.priority} onPress={() => void agenda.toggle(item.task!)} /> : null}
      <Text style={[st.timedTitle, done && st.done]} numberOfLines={3}>
        {item.title}
      </Text>
      <RowLine />
    </Pressable>
  );
}

function DayScreen({ day, onGo, onBack, onTask, onEvent }: { day: string; onGo: (d: string) => void; onBack: () => void; onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void }) {
  const a = useAgenda();
  useEvents(addDays(day, -1), addDays(day, 1));
  const swipe = useSwipe(() => onGo(addDays(day, -1)), () => onGo(addDays(day, 1)));
  const evs = visibleEvents(a, day);
  const allDay = evs.filter((e) => e.allDay);
  const tasks = onDay(a.tasks, day);
  const items = timeline(day, evs, tasks);
  const untimed = tasks.filter((x) => !x.time);
  const d = parseYmd(day);
  const t = today();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const nowAt = day === t ? items.findIndex((x) => x.min > nowMin) : -2;
  const label = dayLabel(day);
  const relative = label === "Oggi" || label === "Domani" || label === "Ieri" ? label : null;

  return (
    <View style={{ flex: 1 }}>
      <BackBar
        label={cap(monthLong(d.getMonth()))}
        onPress={onBack}
        right={
          <View style={{ flexDirection: "row", gap: 22 }}>
            <Pressable onPress={() => onGo(addDays(day, -1))} hitSlop={12}>
              <Glyph name="nav.prev" size={22} color={C.accent} weight={1.2} />
            </Pressable>
            <Pressable onPress={() => onGo(addDays(day, 1))} hitSlop={12}>
              <Glyph name="nav.next" size={22} color={C.accent} weight={1.2} />
            </Pressable>
          </View>
        }
      />
      <View style={st.dayHead}>
        <Text style={st.dayTitle}>
          {cap(WD_LONG[d.getDay()])} {d.getDate()}
        </Text>
        <Text style={st.daySub}>
          {relative ? `${relative} · ` : ""}
          {monthLong(d.getMonth())} {d.getFullYear()}
        </Text>
      </View>
      <CalendarAccess />
      <ScrollView
        {...swipe}
        refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.changedOutside()} />}
        contentContainerStyle={{ paddingBottom: 140 }}
      >
        {allDay.length ? <SectionHeader title="Tutto il giorno" /> : null}
        {allDay.map((e) => (
          <Pressable key={`${e.id}-${e.start.getTime()}`} onPress={() => onEvent(e)} style={({ pressed }) => [st.timed, pressed && { backgroundColor: C.line }]}>
            <HandBar color={e.color} style={{ marginLeft: 16 }} />
            <Text style={[st.timedTitle, /^\s*✓/.test(e.title) && st.done]} numberOfLines={2}>
              {e.title}
            </Text>
            <RowLine />
          </Pressable>
        ))}

        {items.length ? <SectionHeader title="Programma" right={`${items.length}`} /> : null}
        {items.map((x, i) => (
          <View key={x.key}>
            {i === nowAt ? <NowLine /> : null}
            <TimedRow item={x} onTask={onTask} onEvent={onEvent} />
          </View>
        ))}
        {items.length && nowAt === -1 ? <NowLine /> : null}

        {untimed.length ? <SectionHeader title="Attività" right={`${untimed.filter((x) => !x.done).length} da fare`} /> : null}
        {untimed.map((x) => (
          <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />
        ))}

        {!allDay.length && !items.length && !untimed.length ? <Empty text="Niente in programma. Tocca + per aggiungere." /> : null}
      </ScrollView>
    </View>
  );
}

function NowLine() {
  return (
    <View style={st.now}>
      <Text style={st.nowText}>{hm(new Date())}</Text>
      <NowMark />
    </View>
  );
}

// ---------------------------------------------------------------- screen

export function CalendarScreen({
  onTask,
  onEvent,
  onDayChange,
  onAdd,
  jump,
}: {
  onTask: (t: VaultTask) => void;
  onEvent: (e: CalEvent) => void;
  onDayChange: (d: string | null) => void;
  onAdd: () => void;
  jump?: { day: string | null; at: number } | null;
}) {
  const t = today();
  const [month, setMonth] = useState(ymd(new Date(parseYmd(t).getFullYear(), parseYmd(t).getMonth(), 1)));
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => onDayChange(day), [day]);
  const openDay = (d: string) => {
    setDay(d);
    const x = parseYmd(d);
    setMonth(ymd(new Date(x.getFullYear(), x.getMonth(), 1)));
  };
  // from a widget
  useEffect(() => {
    if (!jump) return;
    if (jump.day) openDay(jump.day);
    else setDay(null);
  }, [jump?.at]);
  return day ? (
    <DayScreen day={day} onGo={openDay} onBack={() => setDay(null)} onTask={onTask} onEvent={onEvent} />
  ) : (
    <MonthScreen month={month} onMonth={setMonth} onOpen={openDay} onAdd={onAdd} />
  );
}

const st = themed(() => StyleSheet.create({
  nav: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 6 },
  monthTitle: { fontSize: 28, fontWeight: "700", color: C.text },
  year: { fontSize: 13, color: C.sub, marginTop: -2 },
  tools: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  pill: { paddingHorizontal: 14, paddingVertical: 6 },
  pillText: { color: C.accent, fontWeight: "600", fontSize: 16 },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, backgroundColor: "#FFF4E5" },
  bannerText: { color: "#8A4B00", fontSize: 14 },
  weekHead: { flexDirection: "row", paddingHorizontal: 8, paddingBottom: 6 },
  weekHeadText: { flex: 1, textAlign: "center", fontSize: 14, color: C.sub },
  weekRow: { flexDirection: "row", paddingHorizontal: 8 },
  cell: { flex: 1, alignItems: "center", paddingTop: 4, borderRadius: 6, overflow: "hidden" },
  num: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  numText: { fontSize: 17, color: C.text },
  previews: { alignSelf: "stretch", paddingHorizontal: 1, marginTop: 1, gap: 1 },
  pv: { fontSize: 10.5, lineHeight: 13, paddingHorizontal: 2, borderRadius: 3, overflow: "hidden" },
  pvDone: { color: C.faint, textDecorationLine: "line-through" },
  pvMore: { fontSize: 10, lineHeight: 13, color: C.sub },
  dayNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8 },
  back: { fontSize: 17, color: C.accent },
  dayHead: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 8 },
  dayTitle: { fontSize: 32, fontWeight: "700", color: C.text },
  daySub: { fontSize: 15, color: C.sub, marginTop: 2 },
  timed: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingRight: 16 },
  time: { width: 62, alignItems: "flex-end" },
  timeFrom: { fontSize: 15, color: C.text, fontWeight: "600", fontVariant: ["tabular-nums"] },
  timeTo: { fontSize: 12, color: C.faint, fontVariant: ["tabular-nums"] },
  timedTitle: { flex: 1, fontSize: 17, color: C.text },
  done: { color: C.faint, textDecorationLine: "line-through" },
  now: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, paddingRight: 12 },
  nowText: { width: 62, textAlign: "right", fontSize: 12, color: C.accent, fontWeight: "700" },
}));
