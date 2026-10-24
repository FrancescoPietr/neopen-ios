// "Oggi": the strip of days (Fantastical's DayTicker) and the agenda of the chosen day; "Prossimi": the next two weeks
// (Todoist's Upcoming), events and tasks together.
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { agenda, CalEvent, visibleEvents } from "../../app/agenda";
import { onDay, overdue } from "../../core/taskStore";
import { VaultTask, addDays, parseYmd } from "../../core/tasks";
import { C, Empty, EventRow, SectionHeader, Segmented, TaskRow, dayLabel, today, useAgenda, weekdayShort } from "./common";

const BACK = 14;
const AHEAD = 60;

export function DayTicker({ selected, onSelect }: { selected: string; onSelect: (d: string) => void }) {
  const a = useAgenda();
  const t = today();
  const days = useMemo(() => Array.from({ length: BACK + AHEAD }, (_, i) => addDays(t, i - BACK)), [t]);
  const ref = useRef<FlatList<string>>(null);
  const W = 52;
  useEffect(() => {
    const i = days.indexOf(selected);
    if (i >= 0) ref.current?.scrollToOffset({ offset: Math.max(0, (i - 2) * W), animated: true });
  }, [selected, days]);
  return (
    <FlatList
      ref={ref}
      horizontal
      data={days}
      keyExtractor={(d) => d}
      showsHorizontalScrollIndicator={false}
      getItemLayout={(_, i) => ({ length: W, offset: W * i, index: i })}
      initialScrollIndex={BACK - 2}
      contentContainerStyle={{ paddingHorizontal: 6 }}
      style={st.ticker}
      renderItem={({ item: d }) => {
        const on = d === selected;
        const evs = visibleEvents(a, d);
        const tasks = a.tasks.filter((x) => x.date === d && !x.done).length;
        const weekend = [0, 6].includes(parseYmd(d).getDay());
        return (
          <Pressable onPress={() => onSelect(d)} style={[st.day, { width: W - 4 }, on && st.dayOn]}>
            <Text style={[st.dayWd, on && { color: "#fff" }, weekend && !on && { color: C.accent }]}>{weekdayShort(d)}</Text>
            <Text style={[st.dayNum, on && { color: "#fff" }, d === t && !on && { color: C.accent }]}>{parseYmd(d).getDate()}</Text>
            <View style={st.dots}>
              {evs.slice(0, 3).map((e, i) => (
                <View key={i} style={[st.dot, { backgroundColor: on ? "#fff" : e.color }]} />
              ))}
              {tasks ? <View style={[st.dot, st.taskDot, on && { borderColor: "#fff" }]} /> : null}
            </View>
          </Pressable>
        );
      }}
    />
  );
}

/** Events then tasks of one day (and the overdue ones, if it's today). */
export function DayAgenda({ day, onTask, onEvent, header = true }: { day: string; onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void; header?: boolean }) {
  const a = useAgenda();
  const t = today();
  const late = day === t ? overdue(a.tasks, t) : [];
  const evs = visibleEvents(a, day);
  const tasks = onDay(a.tasks, day).filter((x) => !x.done || x.doneDate === t || x.date === t);
  return (
    <View>
      {header ? <SectionHeader title={dayLabel(day, true)} right={`${evs.length} eventi · ${tasks.filter((x) => !x.done).length} attività`} /> : null}
      {late.length ? (
        <>
          <SectionHeader title="In ritardo" color={C.red} right={String(late.length)} />
          {late.map((x) => (
            <TaskRow key={x.id} task={x} showDate onPress={() => onTask(x)} />
          ))}
        </>
      ) : null}
      {evs.length ? <SectionHeader title="Calendario" /> : null}
      {evs.map((e) => (
        <EventRow key={`${e.id}-${e.start.getTime()}`} ev={e} onPress={() => onEvent(e)} />
      ))}
      {tasks.length ? <SectionHeader title="Attività" /> : null}
      {tasks.map((x) => (
        <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />
      ))}
      {!evs.length && !tasks.length && !late.length ? <Empty text="Niente in programma." /> : null}
    </View>
  );
}

export function TodayScreen({ onTask, onEvent, onDayChange }: { onTask: (t: VaultTask) => void; onEvent: (e: CalEvent) => void; onDayChange: (d: string) => void }) {
  const a = useAgenda();
  const [mode, setMode] = useState<"day" | "next">("day");
  const [day, setDay] = useState(today());
  useEffect(() => onDayChange(day), [day]);
  useEffect(() => {
    void agenda.loadEvents(parseYmd(addDays(today(), -BACK)), parseYmd(addDays(today(), AHEAD)));
  }, [a.calendarAccess, a.calendars.length, a.version > 0 && Object.keys(a.events).length === 0]);
  const next = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today(), i)), [a.version]);
  return (
    <View style={{ flex: 1 }}>
      <View style={st.header}>
        <Pressable onPress={() => setDay(today())}>
          <Text style={st.title}>{mode === "day" ? dayLabel(day) : "Prossimi"}</Text>
        </Pressable>
        <Text style={st.subtitle}>{mode === "day" ? dayLabel(day, true).replace(/^\w/, (c) => c.toUpperCase()) : "Le prossime due settimane"}</Text>
      </View>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "day", label: "Giorno" },
          { value: "next", label: "Prossimi" },
        ]}
      />
      {mode === "day" ? <DayTicker selected={day} onSelect={setDay} /> : null}
      <ScrollView refreshControl={<RefreshControl refreshing={a.loading} onRefresh={() => void agenda.refresh()} />} contentContainerStyle={{ paddingBottom: 120 }}>
        {mode === "day" ? (
          <DayAgenda day={day} onTask={onTask} onEvent={onEvent} header={false} />
        ) : (
          <>
            {(() => {
              const late = overdue(a.tasks, today());
              return late.length ? (
                <>
                  <SectionHeader title="In ritardo" color={C.red} right={String(late.length)} />
                  {late.map((x) => (
                    <TaskRow key={x.id} task={x} showDate onPress={() => onTask(x)} />
                  ))}
                </>
              ) : null;
            })()}
            {next.map((d) => {
              const evs = visibleEvents(a, d);
              const tasks = onDay(a.tasks, d).filter((x) => !x.done);
              return (
                <View key={d}>
                  <SectionHeader title={dayLabel(d, true).replace(/^\w/, (c) => c.toUpperCase())} right={d === today() ? "oggi" : undefined} />
                  {evs.map((e) => (
                    <EventRow key={`${e.id}-${e.start.getTime()}`} ev={e} onPress={() => onEvent(e)} />
                  ))}
                  {tasks.map((x) => (
                    <TaskRow key={x.id} task={x} onPress={() => onTask(x)} />
                  ))}
                  {!evs.length && !tasks.length ? <Text style={st.free}>libero</Text> : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 8 },
  title: { fontSize: 32, fontWeight: "700", color: C.text },
  subtitle: { fontSize: 15, color: C.sub, marginTop: 2 },
  ticker: { flexGrow: 0, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  day: { alignItems: "center", paddingVertical: 6, marginHorizontal: 2, borderRadius: 12 },
  dayOn: { backgroundColor: C.accent },
  dayWd: { fontSize: 12, color: C.sub, textTransform: "uppercase" },
  dayNum: { fontSize: 19, fontWeight: "600", color: C.text, marginTop: 2 },
  dots: { flexDirection: "row", gap: 2, height: 6, marginTop: 4 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  taskDot: { borderWidth: 1, borderColor: C.sub, backgroundColor: "transparent" },
  free: { color: C.faint, paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, backgroundColor: C.card },
});
