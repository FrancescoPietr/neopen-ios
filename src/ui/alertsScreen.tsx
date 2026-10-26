// "Avvisi e schermata di blocco": when to be alerted (events, tasks with a time, the day's tasks), important alerts
// that come through Full Immersion, and the lock-screen card (appointments with a countdown, tasks of today) — each part can be switched off.
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { alerts } from "../app/alerts";
import { before } from "../core/reminders";
import { T, themed } from "./theme/theme";
import { BackBar, HandFrame, HandSwitch, RowLine, SPACE, Text, TextInput } from "./theme/ui";

const useAlerts = () => useSyncExternalStore(alerts.subscribe, alerts.version);

const OFFSETS = [0, 5, 10, 15, 30, 60, 120, 1440];
export const offsetLabel = (m: number) => (m === 0 ? "All'ora" : m < 60 ? `${m} min prima` : m < 1440 ? `${m / 60} ${m === 60 ? "ora" : "ore"} prima` : "Il giorno prima");

function Section({ title, footer, children }: { title: string; footer?: string; children: React.ReactNode }) {
  return (
    <View style={st.section}>
      <Text style={st.sectionTitle}>{title}</Text>
      <HandFrame style={st.card} seed={`al${title}`}>
        {children}
      </HandFrame>
      {footer ? <Text style={st.footer}>{footer}</Text> : null}
    </View>
  );
}

function Toggle({ label, sub, value, onChange }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={st.row}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={st.rowLabel}>{label}</Text>
        {sub ? <Text style={st.rowSub}>{sub}</Text> : null}
      </View>
      <HandSwitch value={value} onChange={onChange} />
      <RowLine />
    </View>
  );
}

/** Several choices among the minutes before. */
export function OffsetChips({ value, onChange, options = OFFSETS }: { value: number[]; onChange: (v: number[]) => void; options?: number[] }) {
  return (
    <View style={st.chips}>
      {options.map((m) => {
        const on = value.includes(m);
        return (
          <Pressable key={m} onPress={() => onChange(on ? value.filter((x) => x !== m) : [...value, m].sort((a, b) => a - b))}>
            <HandFrame style={st.chip} color={on ? T.accent : T.line} weight={on ? 1.5 : 1} fill={on ? T.accent + "26" : undefined} seed={`off${m}`}>
              <Text style={[st.chipText, on && { color: T.accent }]}>{offsetLabel(m)}</Text>
            </HandFrame>
          </Pressable>
        );
      })}
    </View>
  );
}

export function AlertsScreen({ onBack }: { onBack: () => void }) {
  useAlerts();
  const s = alerts.get();
  const [day, setDay] = useState(s.dayAt);
  const [tested, setTested] = useState("");
  const dayOk = (v: string) => /^\d{1,2}:\d{2}$/.test(v.trim());
  return (
    <View style={{ flex: 1 }}>
      <BackBar label="Penna" onPress={onBack} />
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        <Text style={st.big}>Avvisi</Text>

        <Section title="Avvisi" footer="Per un evento o un'attività puoi scegliere avvisi diversi: tocca l'evento o l'attività e poi «Avvisi».">
          <Toggle label="Avvisi" value={s.on} onChange={(v) => alerts.set({ on: v })} />
          <Toggle
            label="Avvisi importanti"
            sub="Arrivano anche con Full Immersion o Non disturbare attivi, e restano in cima alla lista."
            value={s.important}
            onChange={(v) => alerts.set({ important: v })}
          />
          <Pressable
            style={st.row}
            onPress={async () => setTested((await alerts.test()) ? "Tra 5 secondi arriva un avviso di prova." : "Le notifiche sono spente: Impostazioni di iPhone → NeoTransfer → Notifiche.")}
          >
            <Text style={[st.rowLabel, { color: T.accent }]}>Prova un avviso</Text>
          </Pressable>
          {tested ? <Text style={[st.rowSub, { paddingHorizontal: SPACE.side, paddingBottom: 10 }]}>{tested}</Text> : null}
        </Section>

        {s.on ? (
          <>
            <Section title="Eventi del calendario" footer="Per non avere doppioni, spegni gli avvisi dell'app Calendario: Impostazioni di iPhone → Notifiche → Calendario.">
              <OffsetChips value={s.eventOffsets} onChange={(v) => alerts.set({ eventOffsets: v })} />
              <Text style={st.hint}>{s.eventOffsets.length ? `Ti avviso ${s.eventOffsets.map((m) => before(m).replace("adesso", "all'ora")).join(", ")}.` : "Nessun avviso per gli eventi."}</Text>
            </Section>

            <Section title="Attività con un orario">
              <OffsetChips value={s.taskOffsets} onChange={(v) => alerts.set({ taskOffsets: v })} />
            </Section>

            <Section title="Attività del giorno" footer="Un solo avviso al mattino con le attività di oggi che non hanno un orario.">
              <View style={st.chips}>
                {["", "07:00", "08:00", "09:00", "10:00"].map((v) => {
                  const on = s.dayAt === v;
                  return (
                    <Pressable key={v || "no"} onPress={() => (setDay(v), alerts.set({ dayAt: v }))}>
                      <HandFrame style={st.chip} color={on ? T.accent : T.line} weight={on ? 1.5 : 1} fill={on ? T.accent + "26" : undefined} seed={`day${v}`}>
                        <Text style={[st.chipText, on && { color: T.accent }]}>{v || "Nessuno"}</Text>
                      </HandFrame>
                    </Pressable>
                  );
                })}
              </View>
              <View style={[st.row, { gap: 10 }]}>
                <Text style={st.rowLabel}>Altro orario</Text>
                <HandFrame style={{ width: 90 }} seed="dayat">
                  <TextInput
                    style={st.input}
                    value={day}
                    onChangeText={setDay}
                    onEndEditing={() => (dayOk(day) ? alerts.set({ dayAt: day.trim().padStart(5, "0") }) : setDay(s.dayAt))}
                    placeholder="08:30"
                    keyboardType="numbers-and-punctuation"
                  />
                </HandFrame>
              </View>
            </Section>
          </>
        ) : null}

        <Section
          title="Schermata di blocco"
          footer="Un unico riquadro in basso. iOS lo mostra solo se l'app lo apre mentre è sullo schermo: compare appena apri l'app e poi si aggiorna da solo, anche quando scrivi con la penna. Dopo 8–12 ore iOS lo toglie: torna la volta dopo che apri l'app. Se non compaiono: Impostazioni di iPhone → NeoTransfer → Attività in tempo reale."
        >
          <Toggle
            label="Impegni con il conto alla rovescia"
            sub="Gli impegni delle prossime 24 ore, il più vicino in cima, con quanto manca (e poi quanto dura ancora). Anche nella Dynamic Island."
            value={s.countdown}
            onChange={(v) => alerts.set({ countdown: v })}
          />
          <Toggle label="Attività di oggi" sub="Le attività di oggi ancora da fare, sotto gli impegni: quando ne completi una sparisce." value={s.todayCard} onChange={(v) => alerts.set({ todayCard: v })} />
        </Section>

        <Section
          title="Widget"
          footer="Tieni premuto sulla schermata Home (o sulla schermata di blocco) → Modifica → Aggiungi widget → NeoTransfer: Calendario, Attività o Agenda (tutti e due), in tutte le grandezze. Le attività si spuntano direttamente dal widget."
        >
          <Text style={[st.hint, { paddingTop: 10 }]}>I widget usano lo stesso aspetto dell'app: la tua calligrafia, i colori e i tuoi disegni.</Text>
        </Section>
      </ScrollView>
    </View>
  );
}

const st = themed(() =>
  StyleSheet.create({
    big: { fontSize: 38, fontWeight: "700", color: T.ink, paddingHorizontal: SPACE.side, paddingBottom: 4 },
    section: { marginTop: SPACE.section, marginHorizontal: SPACE.side - 4 },
    sectionTitle: { fontSize: 16, color: T.inkSoft, marginLeft: 12, marginBottom: 4 },
    card: { paddingVertical: 3 },
    footer: { fontSize: 14, color: T.inkSoft, marginHorizontal: 12, marginTop: 6, lineHeight: 19 },
    row: { minHeight: 50, paddingHorizontal: SPACE.side, paddingVertical: 10, flexDirection: "row", alignItems: "center" },
    rowLabel: { fontSize: 18, color: T.ink },
    rowSub: { fontSize: 14, color: T.inkSoft, marginTop: 2, lineHeight: 18 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
    chip: { paddingHorizontal: 12, paddingVertical: 6 },
    chipText: { fontSize: 15, color: T.ink },
    hint: { fontSize: 14, color: T.inkSoft, paddingHorizontal: SPACE.side, paddingBottom: 12, lineHeight: 19 },
    input: { fontSize: 17, paddingHorizontal: 10, paddingVertical: 6, color: T.ink, textAlign: "center" },
  })
);
