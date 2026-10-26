// Drawing the look with the pen: the app asks for one element at a time ("Disegna l'icona Calendario"), you draw it
// anywhere free on your notebook, it appears here as you draw, then «Salva» (or «Rifai»). What you draw becomes part
// of «I miei disegni» (Aspetto → Disegni).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { model } from "../app/model";
import { lineProfile, normalize } from "../core/drawing";
import { pageId } from "../core/models";
import { ELEMENT } from "./theme/catalog";
import { drawings } from "./theme/drawings";
import { Pt, drawnPath, drawnPathIn, profileLine } from "./theme/rough";
import { T, theme, themed } from "./theme/theme";
import { BackBar, Glyph, HandFrame, Text } from "./theme/ui";

const keyOf = (page: string, t: number) => `${page}:${t}`;

/** Strokes on the pages right now (to recognise the new ones). */
function currentKeys(): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of model.store.pages) for (const s of r.strokes) out.add(keyOf(id, s.t));
  return out;
}

/** The strokes written since `mark` (on the page of the first of them). */
function useNewStrokes(mark: Set<string>): number[][] {
  const [tick, setTick] = useState(0);
  useEffect(() => model.store.subscribe(() => setTick((n) => n + 1)), []);
  return useMemo(() => {
    const fresh: { page: string; t: number; pts: number[] }[] = [];
    for (const [id, r] of model.store.pages) for (const s of r.strokes) if (s.tip !== 1 && !mark.has(keyOf(id, s.t))) fresh.push({ page: id, t: s.t, pts: s.pts });
    if (!fresh.length) return [];
    fresh.sort((a, b) => a.t - b.t);
    const page = fresh[0].page;
    return fresh.filter((s) => s.page === page).map((s) => s.pts);
  }, [mark, tick]);
}

function PenState() {
  const m = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const ready = m.bleState === "ready" && m.phase.kind === "listening";
  const text = !m.settings.live
    ? "Attiva «Tratti in tempo reale» nelle impostazioni della penna: serve per vedere qui quello che disegni."
    : ready
      ? "Penna pronta: disegna in un angolo libero del taccuino."
      : m.bleState === "ready"
        ? "La penna si sta collegando…"
        : "Togli il tappo della penna: si collega da sola.";
  return (
    <View style={st.state}>
      <Glyph name={ready ? "write" : "pen"} size={22} color={ready ? T.green : T.orange} />
      <Text style={[st.stateText, { color: ready ? T.green : T.orange }]}>{text}</Text>
    </View>
  );
}

/** How the element looks in the app with this drawing (small, where it is used). */
function InPlace({ id, strokes, raw }: { id: string; strokes: Pt[][]; raw: number[][] }) {
  const ink = { stroke: T.ink, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  if (id === "check.empty" || id === "today") {
    const S = id === "today" ? 36 : 26;
    return (
      <View style={st.inPlace}>
        <View style={{ width: S, height: S, alignItems: "center", justifyContent: "center" }}>
          <Svg width={S} height={S} style={{ position: "absolute" }}>
            <Path d={drawnPathIn(strokes, S, S, 2)} {...ink} stroke={id === "today" ? T.accent : T.inkSoft} strokeWidth={2} />
          </Svg>
          {id === "today" ? <Text style={{ fontSize: 17, color: T.accent, fontWeight: "700" }}>25</Text> : null}
        </View>
        {id === "check.empty" ? <Text style={st.inPlaceText}>completare l'app</Text> : null}
      </View>
    );
  }
  if (id === "rule") {
    const prof = lineProfile(raw);
    return (
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        {[0, 1, 2].map((k) => (
          <Svg key={k} width={340} height={10}>
            <Path d={profileLine(2, 5, 338, 5, prof, `prova${k}`)} {...ink} stroke={T.line} strokeWidth={1.5} />
          </Svg>
        ))}
      </View>
    );
  }
  return (
    <View style={st.inPlace}>
      {[18, 26, 40].map((sz) => (
        <Svg key={sz} width={sz} height={sz}>
          <Path d={drawnPath(strokes, sz)} {...ink} strokeWidth={id === "dot" ? sz * 0.3 : Math.max(1.5, sz * 0.075)} />
        </Svg>
      ))}
    </View>
  );
}

export function DrawScreen({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  useSyncExternalStore(theme.subscribe, () => theme.version);
  const [i, setI] = useState(0);
  const [mark, setMark] = useState<Set<string>>(() => currentKeys());
  const id = ids[i];
  const el = ELEMENT.get(id);
  const raw = useNewStrokes(mark);
  const strokes = useMemo(() => normalize(raw), [raw]);
  const big = 220;
  const path = useMemo(() => (strokes.length ? drawnPath(strokes, 100) : ""), [strokes]);
  const mine = drawings.mine(id);

  const next = () => {
    setMark(currentKeys());
    if (i + 1 < ids.length) setI(i + 1);
    else onClose();
  };
  const save = () => {
    if (!strokes.length) return;
    drawings.save(id, id === "rule" ? { strokes, profile: lineProfile(raw) } : { strokes });
    next();
  };

  if (!el) return null;
  return (
    <View style={{ flex: 1 }}>
    <BackBar label="Aspetto" onPress={onClose} right={ids.length > 1 ? <Text style={st.count}>{i + 1} di {ids.length}</Text> : undefined} />
    <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={st.ask}>Disegna:</Text>
      <Text style={st.what}>{el.label}</Text>
      <PenState />

      <View style={{ alignItems: "center", marginTop: 12 }}>
        <HandFrame style={{ width: big, height: big, alignItems: "center", justifyContent: "center" }} seed="canvas">
          {path ? (
            <Svg width={big - 20} height={big - 20} viewBox="0 0 100 100">
              <Path d={path} stroke={T.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </Svg>
          ) : (
            <View style={{ alignItems: "center", gap: 8, paddingHorizontal: 18 }}>
              <Text style={st.wait}>Qui compare quello che disegni.</Text>
              <Text style={st.waitSmall}>Ora c'è questo:</Text>
              {mine?.strokes.length || el.strokes.length ? <Glyph name={id} size={70} color={T.faint} /> : null}
            </View>
          )}
        </HandFrame>
      </View>

      {path ? (
        <>
          <Text style={st.label}>Così nell'app</Text>
          <InPlace id={id} strokes={strokes} raw={raw} />
        </>
      ) : null}

      <View style={st.buttons}>
        <Pressable onPress={() => setMark(currentKeys())} disabled={!path} style={!path && { opacity: 0.4 }}>
          <HandFrame style={st.btn} seed="rifai">
            <Text style={st.btnText}>Rifai</Text>
          </HandFrame>
        </Pressable>
        <Pressable onPress={save} disabled={!path} style={!path && { opacity: 0.4 }}>
          <HandFrame style={st.btn} color={T.accent} fill={T.accent + "2E"} weight={1.5} seed="salva">
            <Text style={[st.btnText, { color: T.accent, fontWeight: "700" }]}>{i + 1 < ids.length ? "Salva e avanti" : "Salva"}</Text>
          </HandFrame>
        </Pressable>
      </View>
      <View style={st.buttons}>
        {ids.length > 1 ? (
          <Pressable onPress={next}>
            <Text style={st.link}>Salta</Text>
          </Pressable>
        ) : null}
        {mine ? (
          <Pressable
            onPress={() => {
              drawings.remove(id);
              setMark(currentKeys());
            }}
          >
            <Text style={st.link}>Togli il mio disegno</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={st.tip}>
        Consiglio: disegna grande (2–3 cm) e senza riempire. Se sbagli tocca «Rifai» e ridisegna accanto: conta solo quello che disegni dopo.
      </Text>
    </ScrollView>
    </View>
  );
}

const st = themed(() =>
  StyleSheet.create({
    top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 8 },
    back: { fontSize: 18, color: T.accent },
    count: { fontSize: 15, color: T.inkSoft },
    ask: { fontSize: 18, color: T.inkSoft, paddingHorizontal: 16, paddingTop: 4 },
    what: { fontSize: 30, fontWeight: "700", color: T.ink, paddingHorizontal: 16 },
    state: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8 },
    stateText: { fontSize: 15, flex: 1 },
    wait: { fontSize: 16, color: T.inkSoft, textAlign: "center" },
    waitSmall: { fontSize: 13, color: T.faint },
    label: { fontSize: 15, color: T.inkSoft, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 },
    inPlace: { flexDirection: "row", alignItems: "center", gap: 18, paddingHorizontal: 20 },
    inPlaceText: { fontSize: 17, color: T.ink },
    buttons: { flexDirection: "row", justifyContent: "center", gap: 16, marginTop: 20 },
    btn: { paddingHorizontal: 22, paddingVertical: 10, minWidth: 110, alignItems: "center" },
    btnText: { fontSize: 18, color: T.ink },
    link: { fontSize: 16, color: T.accent, paddingHorizontal: 8 },
    tip: { fontSize: 14, color: T.inkSoft, paddingHorizontal: 20, paddingTop: 22, lineHeight: 19 },
  })
);
