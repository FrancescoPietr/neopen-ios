// The look of the app (saved on the phone in aspetto.json): colors, paper, handwriting, hand-drawn outlines.
// `T` always holds the current values; the screens read it while drawing, and when the look changes the whole app is
// drawn again (App.tsx uses the version as key), so nothing keeps old colors.
import { readJson, writeJson } from "../../app/files";
import { ColorChoice, Palette, PRESETS, STANDARD, makePalette } from "./colors";

export type Pattern = "puntini" | "righe" | "quadretti" | "liscio";
export type FontChoice = "mano" | "sistema";

export interface Look extends ColorChoice {
  /** Preset the colors come from ("" = chosen by hand). */
  preset: string;
  pattern: Pattern;
  font: FontChoice;
  /** Text size: 0.85 … 1.3. */
  textScale: number;
}

export const STANDARD_LOOK: Look = { preset: STANDARD.id, paper: STANDARD.paper, ink: STANDARD.ink, accent: STANDARD.accent, pattern: "puntini", font: "mano", textScale: 1 };

const FILE = "aspetto.json";

/** Name of the handwriting font (embedded in the app, see app.json). */
export const HAND_FONT = "Fra";

export interface ThemeValues extends Palette {
  look: Look;
  /** fontFamily for the texts (undefined = the iPhone's font). */
  fontFamily: string | undefined;
  /** Handwriting: no bold, slightly bigger (the hand font is light and has no bold). */
  hand: boolean;
  /** Multiplier of all text sizes. */
  textScale: number;
}

function compute(look: Look): ThemeValues {
  const hand = look.font === "mano";
  return {
    ...makePalette(look),
    look,
    fontFamily: hand ? HAND_FONT : undefined,
    hand,
    textScale: (hand ? 1.08 : 1) * Math.min(1.3, Math.max(0.85, look.textScale || 1)),
  };
}

let look: Look = { ...STANDARD_LOOK, ...readJson<Partial<Look>>(FILE, {}) };
let version = 1;
const listeners = new Set<() => void>();

/** Current values (read them while rendering). */
export const T: ThemeValues = compute(look);

export const theme = {
  get version() {
    return version;
  },
  get look(): Look {
    return look;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  set(patch: Partial<Look>): void {
    look = { ...look, ...patch };
    // colors changed by hand: no longer a preset
    if ((patch.paper || patch.ink || patch.accent) && patch.preset === undefined) {
      const p = PRESETS.find((x) => x.paper === look.paper && x.ink === look.ink && x.accent === look.accent);
      look.preset = p?.id ?? "";
    }
    Object.assign(T, compute(look));
    version++;
    writeJson(FILE, look);
    for (const fn of listeners) fn();
  },
  usePreset(id: string): void {
    const p = PRESETS.find((x) => x.id === id);
    if (p) this.set({ preset: p.id, paper: p.paper, ink: p.ink, accent: p.accent });
  },
  reset(): void {
    this.set({ ...STANDARD_LOOK });
  },
};

/**
 * Styles that follow the look: `const st = themed(() => StyleSheet.create({ … T.ink … }))`. The object is made again
 * the first time it is read after the look changed.
 */
export function themed<S extends object>(factory: () => S): S {
  let made: S | null = null;
  let at = 0;
  const current = () => {
    if (!made || at !== version) {
      made = factory();
      at = version;
    }
    return made;
  };
  return new Proxy({} as S, {
    get: (_t, k) => (current() as Record<string | symbol, unknown>)[k],
    has: (_t, k) => k in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_t, k) => Object.getOwnPropertyDescriptor(current(), k),
  });
}
