// Building blocks that follow the look: texts in the chosen handwriting and colors, and everything that would be a
// perfect digital shape (lines, boxes, circles, check boxes, switches, dots) drawn as if with a pen.
import { createContext, ReactNode, useContext, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, StyleProp, StyleSheet, Text as RNText, TextInput as RNTextInput, TextInputProps, TextProps, TextStyle, View, ViewStyle } from "react-native";
import Svg, { Circle, Defs, Line, Path, Pattern, Rect } from "react-native-svg";
import { ELEMENT } from "./catalog";
import { roughBlob, roughCircle, roughLine, roughRect, strokesPath } from "./rough";
import { T } from "./theme";

// ---------------------------------------------------------------- texts

const InText = createContext(false);

/** The hand font has no "·", "–", "—": they become its "•" and "-". */
function swapMissing(children: ReactNode): ReactNode {
  if (!T.hand) return children;
  const fix = (x: string) => x.replace(/·/g, "•").replace(/[–—]/g, "-");
  if (typeof children === "string") return fix(children);
  if (Array.isArray(children)) return children.map((c) => (typeof c === "string" ? fix(c) : c));
  return children;
}

function adapt(style: StyleProp<TextStyle>, nested: boolean): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const out: { -readonly [K in keyof TextStyle]: TextStyle[K] } = nested ? { ...flat } : { color: T.ink, ...flat };
  if (!nested || flat.fontSize) out.fontSize = (flat.fontSize ?? 15) * T.textScale;
  if (flat.lineHeight) out.lineHeight = flat.lineHeight * T.textScale;
  if (T.fontFamily) {
    out.fontFamily = T.fontFamily;
    const w = Number(flat.fontWeight ?? 400);
    delete out.fontWeight;
    delete out.fontVariant;
    // the handwriting has no bold: a heavier stroke (the text drawn twice, a hair apart)
    if (w >= 600) {
      out.textShadowColor = (out.color as string) ?? T.ink;
      out.textShadowOffset = { width: 0.55, height: 0 };
      out.textShadowRadius = 0.01;
    }
  }
  return out;
}

export function Text({ style, children, ...rest }: TextProps) {
  const nested = useContext(InText);
  return (
    <InText.Provider value={true}>
      <RNText {...rest} style={adapt(style, nested)}>
        {swapMissing(children)}
      </RNText>
    </InText.Provider>
  );
}

export function TextInput({ style, placeholderTextColor, ...rest }: TextInputProps) {
  return <RNTextInput {...rest} placeholderTextColor={placeholderTextColor ?? T.faint} selectionColor={T.accent} style={adapt(style, false)} />;
}

// ---------------------------------------------------------------- size of a view

function useSize(): [{ w: number; h: number }, (e: LayoutChangeEvent) => void] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - size.w) > 0.5 || Math.abs(height - size.h) > 0.5) setSize({ w: width, h: height });
  };
  return [size, onLayout];
}

/** A seed fixed for the life of the element (each line wobbles its own way, always the same). */
function useSeed(given?: string): string {
  const r = useRef(given ?? Math.random().toString(36).slice(2, 8));
  return r.current;
}

const strokeW = (size: number) => Math.max(1.5, size * 0.075);

// ---------------------------------------------------------------- drawings

/** An element of the catalogue (icons, arrows…), hand-drawn. */
export function Glyph({ name, size = 22, color, weight = 1, style }: { name: string; size?: number; color?: string; weight?: number; style?: StyleProp<ViewStyle> }) {
  const el = ELEMENT.get(name);
  const d = useMemo(() => (el ? strokesPath(el.strokes, name, size) : ""), [name, size, el]);
  if (!el || !d) return null;
  const sw = strokeW(size) * weight;
  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none">
      <Svg width={size} height={size} viewBox={`${-sw} ${-sw} ${size + 2 * sw} ${size + 2 * sw}`}>
        <Path d={d} stroke={color ?? T.ink} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}

/** A horizontal line drawn by hand, as wide as its place. */
export function HandLine({ color, weight = 1, style, seed }: { color?: string; weight?: number; style?: StyleProp<ViewStyle>; seed?: string }) {
  const [size, onLayout] = useSize();
  const s = useSeed(seed);
  const d = useMemo(() => (size.w ? roughLine(1, 3, size.w - 1, 3, s, Math.min(1.4, size.w / 160)) : ""), [size.w, s]);
  return (
    <View style={[{ height: 6 }, style]} onLayout={onLayout} pointerEvents="none">
      {d ? (
        <Svg width={size.w} height={6}>
          <Path d={d} stroke={color ?? T.line} strokeWidth={1.3 * weight} strokeLinecap="round" fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}

/** A short vertical stroke (the color of an event's calendar), as tall as its place. */
export function HandBar({ color, style }: { color: string; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  const s = useSeed();
  const d = useMemo(() => (size.h ? roughLine(3, 2, 3, size.h - 2, s, 0.7) : ""), [size.h, s]);
  return (
    <View style={[{ width: 6, alignSelf: "stretch" }, style]} onLayout={onLayout} pointerEvents="none">
      {d ? (
        <Svg width={6} height={size.h}>
          <Path d={d} stroke={color} strokeWidth={3.2} strokeLinecap="round" fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}

/** The line under a row of a list (instead of the thin digital border). */
export function RowLine({ left = 16 }: { left?: number }) {
  return <HandLine style={{ position: "absolute", left, right: 8, bottom: -3 }} />;
}

/** A box drawn by hand around its content (cards, buttons). `fill` = the paper inside. */
export function HandFrame({ children, style, color, fill, weight = 1, seed }: { children?: ReactNode; style?: StyleProp<ViewStyle>; color?: string; fill?: string; weight?: number; seed?: string }) {
  const [size, onLayout] = useSize();
  const s = useSeed(seed);
  const d = useMemo(() => (size.w ? roughRect(size.w, size.h, s, 2, Math.min(1.5, Math.max(0.6, size.w / 200))) : ""), [size.w, size.h, s]);
  return (
    <View style={[style, { backgroundColor: undefined }]} onLayout={onLayout}>
      {fill ? <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, margin: 3, borderRadius: 4 }]} pointerEvents="none" /> : null}
      {children}
      {d ? (
        <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Path d={d} stroke={color ?? T.line} strokeWidth={1.5 * weight} strokeLinecap="round" fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}

/** The check box of a task: a circle drawn with the pen; ticked = a tick that goes past the circle. */
export function HandCheck({ done, color, size = 24, onPress }: { done: boolean; color: string; size?: number; onPress?: () => void }) {
  const s = useSeed();
  const circle = useMemo(() => roughCircle(size / 2, size / 2, size / 2 - 3, size / 2 - 3, s, 0.07), [size, s]);
  const tick = useMemo(() => strokesPath(ELEMENT.get("check.done")!.strokes, "tick" + s, size), [size, s]);
  return (
    <Pressable onPress={onPress} hitSlop={10} style={{ width: size, height: size }}>
      <Svg width={size + 6} height={size + 6} viewBox={`-3 -3 ${size + 6} ${size + 6}`} style={{ position: "absolute", left: -3, top: -3 }}>
        <Path d={circle} stroke={done ? T.faint : color} strokeWidth={1.8} strokeLinecap="round" fill="none" />
        {done ? <Path d={tick} stroke={T.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" /> : null}
      </Svg>
    </Pressable>
  );
}

/** A circle drawn around something (the number of today). */
export function HandRing({ size, color, weight = 1 }: { size: number; color?: string; weight?: number }) {
  const s = useSeed();
  const d = useMemo(() => roughCircle(size / 2, size / 2, size / 2 - 3, size / 2 - 4, s, 0.06, 0.5), [size, s]);
  return (
    <Svg width={size} height={size} style={{ position: "absolute" }} pointerEvents="none">
      <Path d={d} stroke={color ?? T.accent} strokeWidth={2.2 * weight} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** A small blob of ink (the dot of a busy day). */
export function Dot({ size = 7, color }: { size?: number; color?: string }) {
  const s = useSeed();
  const d = useMemo(() => roughBlob(size / 2 + 1, size / 2 + 1, size / 2, s, 0.12), [size, s]);
  return (
    <Svg width={size + 2} height={size + 2} pointerEvents="none">
      <Path d={d} fill={color ?? T.ink} />
    </Svg>
  );
}

/** On/off drawn by hand: a long loop with a blob inside, on the right and colored when on. */
export function HandSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const s = useSeed();
  const W = 52;
  const H = 30;
  const loop = useMemo(() => roughCircle(W / 2, H / 2, W / 2 - 3, H / 2 - 3, s, 0.04, 0.3), [s]);
  const knob = useMemo(() => roughBlob(value ? W - 15 : 15, H / 2, 9, s + (value ? "1" : "0"), 0.1), [value, s]);
  return (
    <Pressable onPress={() => onChange(!value)} hitSlop={8} style={{ width: W, height: H }}>
      <Svg width={W} height={H}>
        <Path d={loop} stroke={value ? T.accent : T.line} strokeWidth={1.8} strokeLinecap="round" fill="none" />
        <Path d={knob} fill={value ? T.accent : T.faint} />
      </Svg>
    </Pressable>
  );
}

/** A straight line with a blob at the start (the time "now" in a day). */
export function NowMark({ color }: { color?: string }) {
  const [size, onLayout] = useSize();
  const s = useSeed();
  const d = useMemo(() => (size.w ? roughLine(8, 5, size.w - 2, 5, s, 0.8) : ""), [size.w, s]);
  const blob = useMemo(() => roughBlob(5, 5, 4, s), [s]);
  return (
    <View style={{ height: 10, flex: 1 }} onLayout={onLayout} pointerEvents="none">
      {d ? (
        <Svg width={size.w} height={10}>
          <Path d={blob} fill={color ?? T.accent} />
          <Path d={d} stroke={color ?? T.accent} strokeWidth={2} strokeLinecap="round" fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- paper

/** The background of the screens: the paper color with its ruling (dots, lines, squares or nothing). */
export function Paper({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const pattern = T.look.pattern;
  const G = 24;
  return (
    <View style={[{ flex: 1, backgroundColor: T.paper }, style]}>
      {pattern !== "liscio" ? (
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <Pattern id="ruling" x="0" y="0" width={G} height={G} patternUnits="userSpaceOnUse">
              {pattern === "puntini" ? <Circle cx={G / 2} cy={G / 2} r={1.1} fill={T.rule} /> : null}
              {pattern === "righe" ? <Line x1="0" y1={G - 0.5} x2={G} y2={G - 0.5} stroke={T.rule} strokeWidth={1} /> : null}
              {pattern === "quadretti" ? <Path d={`M0 ${G - 0.5}H${G}M${G - 0.5} 0V${G}`} stroke={T.rule} strokeWidth={0.8} /> : null}
            </Pattern>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#ruling)" />
        </Svg>
      ) : null}
      {children}
    </View>
  );
}
