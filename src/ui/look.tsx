// "Aspetto": colors of paper, writing and highlights, the ruling of the paper, the handwriting, the size of the text,
// and the drawings of the app (the catalogue: in step 2 each one can be drawn again with the pen).
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { CATALOG, Group } from "./theme/catalog";
import { PRESETS, SWATCHES, isHex, makePalette } from "./theme/colors";
import { FontChoice, Pattern, T, theme, themed } from "./theme/theme";
import { Dot, Glyph, HandCheck, HandFrame, HandRing, RowLine, Text, TextInput } from "./theme/ui";

const useLook = () => useSyncExternalStore(theme.subscribe, () => theme.version);

function Title({ children, hint }: { children: string; hint?: string }) {
  return (
    <View style={st.titleBox}>
      <Text style={st.title}>{children}</Text>
      {hint ? <Text style={st.hint}>{hint}</Text> : null}
    </View>
  );
}

/** A color to choose: a blob of ink, circled when chosen. */
function Swatch({ color, on, onPress }: { color: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={st.swatch} hitSlop={4}>
      <HandRing size={40} color={on ? T.ink : T.line} weight={on ? 1.3 : 0.6} />
      <Dot size={26} color={color} />
    </Pressable>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [hex, setHex] = useState(value);
  return (
    <View>
      <View style={st.swatches}>
        {SWATCHES.map((c) => (
          <Swatch key={c} color={c} on={c.toUpperCase() === value.toUpperCase()} onPress={() => (setHex(c), onChange(c))} />
        ))}
      </View>
      <View style={st.hexRow}>
        <Text style={st.hexLabel}>Codice</Text>
        <HandFrame style={st.hexBox} seed={`hex${value}`}>
          <TextInput
            style={st.hexInput}
            value={hex}
            onChangeText={setHex}
            onEndEditing={() => (isHex(hex) ? onChange(hex.startsWith("#") ? hex : `#${hex}`) : setHex(value))}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="#F6F0E1"
          />
        </HandFrame>
      </View>
    </View>
  );
}

function Choice<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <View style={st.choices}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)}>
          <HandFrame style={st.choice} color={value === o.value ? T.accent : T.line} weight={value === o.value ? 1.6 : 1} fill={value === o.value ? T.accent + "26" : undefined} seed={`ch${o.value}`}>
            <Text style={[st.choiceText, value === o.value && { fontWeight: "700" }]}>{o.label}</Text>
          </HandFrame>
        </Pressable>
      ))}
    </View>
  );
}

/** A small page in the colors of a preset. */
function PresetCard({ id, name, paper, ink, accent, on }: { id: string; name: string; paper: string; ink: string; accent: string; on: boolean }) {
  const p = makePalette({ paper, ink, accent });
  return (
    <Pressable onPress={() => theme.usePreset(id)} style={{ alignItems: "center", gap: 4 }}>
      <HandFrame style={st.preset} color={on ? T.accent : p.line} weight={on ? 1.8 : 1} fill={paper} seed={`pr${id}`}>
        <Text style={{ fontSize: 22, color: ink }}>Aa</Text>
        <Dot size={10} color={accent} />
      </HandFrame>
      <Text style={[st.presetName, on && { color: T.accent }]}>{name}</Text>
    </Pressable>
  );
}

export function LookScreen() {
  useLook();
  const look = theme.look;
  const groups = [...new Set(CATALOG.map((e) => e.group))] as Group[];
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={st.big}>Aspetto</Text>

      {/* preview */}
      <HandFrame style={st.preview} seed="preview">
        <Text style={st.previewTitle}>Oggi · sabato 24 ottobre</Text>
        <View style={st.previewRow}>
          <HandCheck done={false} color={T.inkSoft} />
          <Text style={st.previewText}>completare l'app</Text>
        </View>
        <View style={st.previewRow}>
          <HandCheck done color={T.inkSoft} />
          <Text style={[st.previewText, { color: T.faint, textDecorationLine: "line-through" }]}>fare la spesa</Text>
        </View>
        <View style={st.previewRow}>
          <Glyph name="tab.calendar" size={22} color={T.accent} />
          <Text style={[st.previewText, { color: T.accent }]}>18:00 Palestra</Text>
        </View>
      </HandFrame>

      <Title>Stili pronti</Title>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.presets}>
        {PRESETS.map((p) => (
          <PresetCard key={p.id} {...p} on={look.preset === p.id} />
        ))}
      </ScrollView>

      <Title hint="Il colore del foglio dietro a tutto.">Sfondo</Title>
      <ColorPicker value={look.paper} onChange={(c) => theme.set({ paper: c })} />

      <Title hint="Il colore di scritte e disegni. Se è troppo simile allo sfondo, l'app lo scurisce (o schiarisce) per farlo leggere.">Scrittura</Title>
      <ColorPicker value={look.ink} onChange={(c) => theme.set({ ink: c })} />

      <Title hint="Oggi, pulsanti, frecce, la scelta attiva.">Evidenziatore</Title>
      <ColorPicker value={look.accent} onChange={(c) => theme.set({ accent: c })} />

      <Title>Carta</Title>
      <Choice<Pattern>
        value={look.pattern}
        onChange={(v) => theme.set({ pattern: v })}
        options={[
          { value: "puntini", label: "Puntini" },
          { value: "righe", label: "Righe" },
          { value: "quadretti", label: "Quadretti" },
          { value: "liscio", label: "Liscia" },
        ]}
      />

      <Title hint="«La mia calligrafia» è il font fatto a mano. Al passo successivo ognuno potrà scrivere il suo con la penna.">Carattere</Title>
      <Choice<FontChoice>
        value={look.font}
        onChange={(v) => theme.set({ font: v })}
        options={[
          { value: "mano", label: "La mia calligrafia" },
          { value: "sistema", label: "Carattere dell'iPhone" },
        ]}
      />

      <Title>Grandezza del testo</Title>
      <View style={st.sizeRow}>
        <Pressable onPress={() => theme.set({ textScale: Math.max(0.85, Math.round((look.textScale - 0.05) * 100) / 100) })} hitSlop={10}>
          <HandFrame style={st.sizeBtn} seed="meno">
            <Text style={st.sizeSign}>A-</Text>
          </HandFrame>
        </Pressable>
        <Text style={st.sizeValue}>{Math.round(look.textScale * 100)}%</Text>
        <Pressable onPress={() => theme.set({ textScale: Math.min(1.3, Math.round((look.textScale + 0.05) * 100) / 100) })} hitSlop={10}>
          <HandFrame style={st.sizeBtn} seed="piu">
            <Text style={[st.sizeSign, { fontSize: 22 }]}>A+</Text>
          </HandFrame>
        </Pressable>
      </View>

      <Title hint="Tutti i disegni dell'app. Per ora sono provvisori: al prossimo passo li potrai ridisegnare uno per uno con la penna.">Disegni</Title>
      {groups.map((g) => (
        <View key={g}>
          <Text style={st.group}>{g}</Text>
          <View style={st.glyphs}>
            {CATALOG.filter((e) => e.group === g).map((e) => (
              <View key={e.id} style={st.glyphCell}>
                {e.strokes.length ? <Glyph name={e.id} size={30} /> : <Text style={st.auto}>auto</Text>}
                <Text style={st.glyphLabel} numberOfLines={2}>
                  {e.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ))}

      <Pressable onPress={() => theme.reset()} style={{ marginTop: 26, marginHorizontal: 16 }}>
        <HandFrame style={st.reset} color={T.accent} seed="reset">
          <Text style={[st.choiceText, { color: T.accent }]}>Torna all'aspetto standard</Text>
        </HandFrame>
      </Pressable>
      <RowLine left={16} />
    </ScrollView>
  );
}

const st = themed(() =>
  StyleSheet.create({
    big: { fontSize: 38, fontWeight: "700", color: T.ink, paddingHorizontal: 16, paddingTop: 4 },
    titleBox: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6 },
    title: { fontSize: 20, fontWeight: "700", color: T.ink },
    hint: { fontSize: 14, color: T.inkSoft, marginTop: 2, lineHeight: 19 },
    preview: { marginHorizontal: 12, marginTop: 10, padding: 14, gap: 8 },
    previewTitle: { fontSize: 18, fontWeight: "700", color: T.ink },
    previewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    previewText: { fontSize: 17, color: T.ink },
    presets: { paddingHorizontal: 12, gap: 12 },
    preset: { width: 78, height: 92, alignItems: "center", justifyContent: "center", gap: 4 },
    presetName: { fontSize: 13, color: T.inkSoft },
    swatches: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10 },
    swatch: { width: 44, height: 44, alignItems: "center", justifyContent: "center", margin: 1 },
    hexRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, marginTop: 6 },
    hexLabel: { fontSize: 15, color: T.inkSoft },
    hexBox: { width: 130 },
    hexInput: { fontSize: 16, paddingHorizontal: 10, paddingVertical: 6, color: T.ink },
    choices: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14 },
    choice: { paddingHorizontal: 14, paddingVertical: 8 },
    choiceText: { fontSize: 16, color: T.ink },
    sizeRow: { flexDirection: "row", alignItems: "center", gap: 18, paddingHorizontal: 16 },
    sizeBtn: { width: 54, height: 44, alignItems: "center", justifyContent: "center" },
    sizeSign: { fontSize: 16, color: T.ink },
    sizeValue: { fontSize: 18, color: T.ink, minWidth: 50, textAlign: "center" },
    group: { fontSize: 15, color: T.inkSoft, paddingHorizontal: 16, paddingTop: 10 },
    glyphs: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8 },
    glyphCell: { width: "25%", alignItems: "center", paddingVertical: 8, gap: 4 },
    glyphLabel: { fontSize: 11, color: T.inkSoft, textAlign: "center", paddingHorizontal: 2 },
    auto: { fontSize: 13, color: T.faint, height: 30, textAlignVertical: "center", paddingTop: 6 },
    reset: { paddingVertical: 12, alignItems: "center" },
  })
);
