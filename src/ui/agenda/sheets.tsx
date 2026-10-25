// Quick add (Todoist + Fantastical), task editor and event details, as iOS sheets.
import { useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Dot, Glyph, HandFrame, Paper, RowLine, Text, TextInput } from "../theme/ui";
import { themed } from "../theme/theme";
import { agenda, CalEvent } from "../../app/agenda";
import { parseQuickAdd } from "../../core/quickadd";
import { projects } from "../../core/taskStore";
import { Priority, VaultTask, addDays, nextOccurrence } from "../../core/tasks";
import { C, Chip, PRIORITY_COLOR, dayLabel, hm, today, useAgenda } from "./common";

function Sheet({ visible, title, onClose, right, children }: { visible: boolean; title: string; onClose: () => void; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Paper>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={st.bar}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={st.barBtn}>Chiudi</Text>
          </Pressable>
          <Text style={st.barTitle}>{title}</Text>
          <View style={{ minWidth: 60, alignItems: "flex-end" }}>{right}</View>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
      </Paper>
    </Modal>
  );
}

function Parsed({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Glyph name={icon} size={15} color={C.accent} />
      <Text style={st.parsed}>{text}</Text>
    </View>
  );
}

const Label = ({ children }: { children: string }) => <Text style={st.label}>{children}</Text>;

// ---------------------------------------------------------------- quick add

export function QuickAddSheet({ visible, onClose, project, date }: { visible: boolean; onClose: () => void; project?: string | null; date?: string | null }) {
  const a = useAgenda();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"task" | "event">("task");
  const [proj, setProj] = useState<string | null>(project ?? null);
  const [calId, setCalId] = useState<string | null>(null);
  useEffect(() => {
    if (visible) {
      setText("");
      setKind("task");
      setProj(project ?? null);
    }
  }, [visible, project]);
  const q = useMemo(() => {
    const p = parseQuickAdd(text, today());
    if (!p.date && date) p.date = date;
    return p;
  }, [text, date]);
  const projectList = useMemo(() => projects(a.tasks).filter((p) => p.own).map((p) => p.name), [a.tasks]);
  const writable = a.calendars.filter((c) => c.writable);
  const target = q.project ?? proj ?? "Inbox";
  const canSave = q.title.length > 0 && (kind === "task" || !!q.date);

  const save = async () => {
    if (!canSave) return;
    const ok = kind === "task" ? await agenda.addTask(q, target) : await agenda.addEvent(q, calId ?? writable[0]?.id ?? null);
    if (ok) onClose();
  };

  return (
    <Sheet
      visible={visible}
      title={kind === "task" ? "Nuova attività" : "Nuovo evento"}
      onClose={onClose}
      right={
        <Pressable onPress={save} disabled={!canSave} hitSlop={12}>
          <Text style={[st.barBtn, { fontWeight: "600", color: canSave ? C.blue : C.faint }]}>Aggiungi</Text>
        </Pressable>
      }
    >
      <HandFrame style={st.card}>
        <TextInput
          style={st.bigInput}
          value={text}
          onChangeText={setText}
          placeholder={kind === "task" ? "es. dentista venerdì alle 15 #salute p1" : "es. cena con Anne sabato alle 20 per 2 ore"}
          autoFocus
          multiline
          onSubmitEditing={save}
          blurOnSubmit
          returnKeyType="done"
        />
        <View style={st.chips}>
          {q.date ? <Parsed icon="tab.calendar" text={dayLabel(q.date)} /> : null}
          {q.time ? <Parsed icon="clock" text={q.end ? `${q.time}–${q.end}` : q.time} /> : null}
          {q.recurrence ? <Parsed icon="repeat" text={italianRecurrence(q.recurrence)} /> : null}
          {q.priority < 4 ? <Text style={[st.parsed, { color: PRIORITY_COLOR[q.priority] }]}>p{q.priority}</Text> : null}
          {q.labels.map((l) => (
            <Text key={l} style={[st.parsed, { color: "#8E44AD" }]}>
              #{l}
            </Text>
          ))}
        </View>
      </HandFrame>

      <Label>Tipo</Label>
      <View style={st.chipRow}>
        <Chip label="Attività" on={kind === "task"} onPress={() => setKind("task")} />
        <Chip label="Evento" on={kind === "event"} onPress={() => setKind("event")} />
      </View>

      {kind === "task" ? (
        <>
          <Label>Progetto</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipRow}>
            {[...new Set(["Inbox", ...projectList, ...(q.project ? [q.project] : [])])].map((p) => (
              <Chip key={p} label={p} on={target === p} onPress={() => setProj(p)} />
            ))}
          </ScrollView>
          <Text style={st.hint}>Scrivi +Nome per un progetto nuovo. Le attività stanno nel vault: Attività/{target}.md</Text>
        </>
      ) : (
        <>
          <Label>Calendario</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipRow}>
            {writable.map((c) => (
              <Chip key={c.id} label={c.title} color={c.color} on={(calId ?? writable[0]?.id) === c.id} onPress={() => setCalId(c.id)} />
            ))}
          </ScrollView>
          {!q.date ? <Text style={[st.hint, { color: C.red }]}>Per un evento serve un giorno (es. «domani», «venerdì», «3 novembre»).</Text> : null}
          {a.calendarAccess !== "granted" ? <Text style={[st.hint, { color: C.red }]}>Serve il permesso per i calendari (scheda Calendario).</Text> : null}
        </>
      )}
      <Text style={st.hint}>
        Capisce: oggi, domani, venerdì, 3 novembre, 17/10, tra 3 giorni · alle 15, dalle 9 alle 11, per 2 ore · ogni giorno/settimana/mese, ogni lunedì · p1–p4 · #etichetta · +Progetto
      </Text>
    </Sheet>
  );
}

export function italianRecurrence(r: string): string {
  const map: Record<string, string> = {
    "every day": "ogni giorno",
    "every week": "ogni settimana",
    "every month": "ogni mese",
    "every year": "ogni anno",
    "every weekday": "giorni feriali",
  };
  if (map[r]) return map[r];
  const n = /^every (\d+) (day|week|month|year)s?$/.exec(r);
  if (n) return `ogni ${n[1]} ${{ day: "giorni", week: "settimane", month: "mesi", year: "anni" }[n[2]]}`;
  const days: Record<string, string> = { monday: "lunedì", tuesday: "martedì", wednesday: "mercoledì", thursday: "giovedì", friday: "venerdì", saturday: "sabato", sunday: "domenica" };
  return r.replace(/^every /, "ogni ").replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, (d) => days[d]);
}

// ---------------------------------------------------------------- task editor

const RECURRENCES: (string | null)[] = [null, "every day", "every weekday", "every week", "every month", "every year"];

export function TaskEditor({ task, onClose }: { task: VaultTask | null; onClose: () => void }) {
  const a = useAgenda();
  const [text, setText] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [dateText, setDateText] = useState("");
  const [time, setTime] = useState("");
  const [end, setEnd] = useState("");
  const [priority, setPriority] = useState<Priority>(4);
  const [recurrence, setRecurrence] = useState<string | null>(null);
  useEffect(() => {
    if (!task) return;
    setText(task.text);
    setDate(task.date);
    setDateText("");
    setTime(task.time ?? "");
    setEnd(task.end ?? "");
    setPriority(task.priority);
    setRecurrence(task.recurrence);
  }, [task]);
  if (!task) return null;
  const projectList = projects(a.tasks).filter((p) => p.own).map((p) => p.name);
  const t = today();
  const okTime = (v: string) => (/^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim().padStart(5, "0") : null);

  const save = async () => {
    let d = date;
    if (dateText.trim()) d = parseQuickAdd(`x ${dateText}`, t).date ?? d;
    const ok = await agenda.edit(task, { text: text.trim() || task.text, date: d, time: okTime(time), end: okTime(time) ? okTime(end) : null, priority, recurrence });
    if (ok) onClose();
  };

  return (
    <Sheet
      visible={!!task}
      title="Attività"
      onClose={onClose}
      right={
        <Pressable onPress={save} hitSlop={12}>
          <Text style={[st.barBtn, { fontWeight: "600" }]}>Salva</Text>
        </Pressable>
      }
    >
      <HandFrame style={st.card}>
        <TextInput style={st.bigInput} value={text} onChangeText={setText} multiline />
      </HandFrame>

      <Label>{`Data${date ? ` · ${dayLabel(date, true)}` : ""}`}</Label>
      <View style={st.chipRow}>
        <Chip label="Oggi" on={date === t} onPress={() => setDate(t)} />
        <Chip label="Domani" on={date === addDays(t, 1)} onPress={() => setDate(addDays(t, 1))} />
        <Chip label="Fine settimana" onPress={() => setDate(parseQuickAdd("x sabato", t).date)} />
        <Chip label="Prossima settimana" onPress={() => setDate(parseQuickAdd("x prossima settimana", t).date)} />
        <Chip label="Nessuna" on={!date} onPress={() => setDate(null)} />
      </View>
      <HandFrame style={st.card}>
        <TextInput style={st.input} value={dateText} onChangeText={setDateText} placeholder="Altra data: es. 15 novembre, giovedì, 3/12" />
      </HandFrame>

      <Label>Ora</Label>
      <HandFrame style={[st.card, { flexDirection: "row" }]}>
        <TextInput style={[st.input, { flex: 1 }]} value={time} onChangeText={setTime} placeholder="inizio (es. 15:00)" keyboardType="numbers-and-punctuation" />
        <TextInput style={[st.input, { flex: 1 }]} value={end} onChangeText={setEnd} placeholder="fine (facoltativa)" keyboardType="numbers-and-punctuation" />
      </HandFrame>

      <Label>Priorità</Label>
      <View style={st.chipRow}>
        {([1, 2, 3, 4] as Priority[]).map((p) => (
          <Chip key={p} label={p === 4 ? "Nessuna" : `p${p}`} color={PRIORITY_COLOR[p]} on={priority === p} onPress={() => setPriority(p)} />
        ))}
      </View>

      <Label>Ripeti</Label>
      <View style={st.chipRow}>
        {RECURRENCES.map((r) => (
          <Chip key={r ?? "no"} label={r ? italianRecurrence(r) : "Mai"} on={recurrence === r} onPress={() => setRecurrence(r)} />
        ))}
      </View>
      {recurrence && date ? <Text style={st.hint}>Prossima volta dopo questa: {dayLabel(nextOccurrence(recurrence, date) ?? date)}</Text> : null}

      <Label>{`Progetto · ${task.project}`}</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipRow}>
        {[...new Set(["Inbox", ...projectList])].filter((p) => p !== task.project).map((p) => (
          <Chip key={p} label={`Sposta in ${p}`} onPress={() => void agenda.move(task, p).then(onClose)} />
        ))}
      </ScrollView>

      <HandFrame style={[st.card, { marginTop: 24 }]}>
        <Pressable style={st.action} onPress={() => void Linking.openURL(agenda.obsidianLink(task.file))}>
          <Text style={[st.actionText, { color: "#7C3AED" }]}>Apri la nota in Obsidian</Text>
          <Text style={st.actionSub}>{task.file}</Text>
          <RowLine />
        </Pressable>
        <Pressable
          style={st.action}
          onPress={() =>
            Alert.alert("Eliminare l'attività?", "La riga viene tolta dalla nota.", [
              { text: "Annulla", style: "cancel" },
              { text: "Elimina", style: "destructive", onPress: () => void agenda.remove(task).then(onClose) },
            ])
          }
        >
          <Text style={[st.actionText, { color: C.red }]}>Elimina</Text>
        </Pressable>
      </HandFrame>
    </Sheet>
  );
}

// ---------------------------------------------------------------- event details

export function EventSheet({ ev, onClose }: { ev: CalEvent | null; onClose: () => void }) {
  const a = useAgenda();
  if (!ev) return null;
  const cal = a.calendars.find((c) => c.id === ev.calendarId);
  const same = ev.start.toDateString() === ev.end.toDateString();
  return (
    <Sheet visible={!!ev} title="Evento" onClose={onClose}>
      <HandFrame style={[st.card, { padding: 16 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Dot size={12} color={ev.color} />
          <Text style={{ fontSize: 22, fontWeight: "700", color: C.text, flex: 1 }}>{ev.title}</Text>
        </View>
        <Text style={st.evLine}>
          {ev.allDay ? `${dayLabel(dayKey(ev.start), true)} · tutto il giorno` : same ? `${dayLabel(dayKey(ev.start), true)} · ${hm(ev.start)}–${hm(ev.end)}` : `${dayLabel(dayKey(ev.start))} ${hm(ev.start)} → ${dayLabel(dayKey(ev.end))} ${hm(ev.end)}`}
        </Text>
        {ev.location ? <Text style={st.evLine}>Luogo: {ev.location}</Text> : null}
        {cal ? <Text style={st.evLine}>Calendario: {cal.title}</Text> : null}
        {ev.recurring ? <Text style={st.evLine}>Evento ricorrente</Text> : null}
      </HandFrame>
      <HandFrame style={[st.card, { marginTop: 24 }]}>
        <Pressable style={st.action} onPress={() => void Linking.openURL(`calshow:${Math.floor(ev.start.getTime() / 1000 - 978307200)}`)}>
          <Text style={st.actionText}>Apri nel Calendario di iPhone</Text>
        </Pressable>
        {cal?.writable && !ev.recurring ? (
          <Pressable
            style={st.action}
            onPress={() =>
              Alert.alert("Eliminare l'evento?", ev.title, [
                { text: "Annulla", style: "cancel" },
                { text: "Elimina", style: "destructive", onPress: () => void agenda.deleteEvent(ev).then(onClose) },
              ])
            }
          >
            <Text style={[st.actionText, { color: C.red }]}>Elimina</Text>
          </Pressable>
        ) : null}
      </HandFrame>
    </Sheet>
  );
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const st = themed(() => StyleSheet.create({
  bar: { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  barBtn: { fontSize: 18, color: C.blue, minWidth: 60 },
  barTitle: { fontSize: 19, fontWeight: "700", color: C.text },
  card: { marginHorizontal: 12, marginTop: 8 },
  bigInput: { fontSize: 18, color: C.text, padding: 14, minHeight: 56 },
  input: { fontSize: 16, color: C.text, paddingHorizontal: 14, paddingVertical: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingBottom: 12 },
  parsed: { fontSize: 15, color: C.blue },
  label: { fontSize: 14, color: C.sub, marginTop: 20, marginBottom: 4, marginHorizontal: 28 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  hint: { fontSize: 13, color: C.sub, marginHorizontal: 32, marginTop: 8, lineHeight: 18 },
  action: { paddingHorizontal: 16, paddingVertical: 14 },
  actionText: { fontSize: 18, color: C.blue },
  actionSub: { fontSize: 12, color: C.faint, marginTop: 2 },
  evLine: { fontSize: 15, color: C.sub, marginTop: 8 },
}));
