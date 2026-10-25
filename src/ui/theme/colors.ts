// Colors of the look: you choose three (paper, ink, accent), the others are mixed from them, so any choice stays
// readable (secondary text, faint text, lines and cards are shades between paper and ink).

export interface Palette {
  /** Background of the screens (the paper). */
  paper: string;
  /** Cards and rows: a little lighter (or darker, on dark paper) than the paper. */
  card: string;
  /** Text and drawings. */
  ink: string;
  /** Secondary text. */
  inkSoft: string;
  /** Faint text, done tasks, placeholders. */
  faint: string;
  /** Hand-drawn lines and borders. */
  line: string;
  /** Ruling of the paper (lines, squares, dots). */
  rule: string;
  /** Highlight: today, buttons, links, selection. */
  accent: string;
  /** Text on the accent color. */
  onAccent: string;
  red: string;
  green: string;
  orange: string;
  dark: boolean;
}

export interface ColorChoice {
  paper: string;
  ink: string;
  accent: string;
}

export interface Preset extends ColorChoice {
  id: string;
  name: string;
}

/** Ready-made: the standard one first. */
export const PRESETS: Preset[] = [
  { id: "taccuino", name: "Taccuino", paper: "#F6F0E1", ink: "#1E2A44", accent: "#D2453F" },
  { id: "bianco", name: "Foglio bianco", paper: "#FDFDFB", ink: "#1C1C1E", accent: "#2F6FDB" },
  { id: "kraft", name: "Kraft", paper: "#E4D3B4", ink: "#3A2A1A", accent: "#2F6B4F" },
  { id: "lavagna", name: "Lavagna", paper: "#25302B", ink: "#EDEBE3", accent: "#F2C14E" },
  { id: "notte", name: "Notte", paper: "#16181D", ink: "#E6E1D6", accent: "#FF7A59" },
  { id: "rosa", name: "Cipria", paper: "#F7E8E4", ink: "#4A2C34", accent: "#B4436C" },
];

export const STANDARD = PRESETS[0];

/** Swatches for choosing a color by hand. */
export const SWATCHES = [
  // papers
  "#FFFFFF", "#FDFDFB", "#F6F0E1", "#F3EAD3", "#E4D3B4", "#F7E8E4", "#E8F0EA", "#E6EDF5", "#EDE7F3",
  "#D9D4C7", "#25302B", "#1F2733", "#16181D", "#000000",
  // inks
  "#1C1C1E", "#1E2A44", "#203A72", "#3A2A1A", "#4A2C34", "#2F4F3A", "#5B2A86", "#EDEBE3", "#E6E1D6",
  // accents
  "#D2453F", "#E5484D", "#FF7A59", "#EB8909", "#F2C14E", "#2F6B4F", "#1E9E4A", "#2F6FDB", "#0A63D6", "#7B5CD6", "#B4436C",
];

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}

export const isHex = (h: string) => parseHex(h) !== null;

export function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** `a` moved towards `b` by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Relative luminance (WCAG). */
export function luminance(h: string): number {
  const [r, g, b] = (parseHex(h) ?? [0, 0, 0]).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The whole palette from the three chosen colors. */
export function makePalette(c: ColorChoice): Palette {
  const paper = isHex(c.paper) ? toHex(parseHex(c.paper)!) : STANDARD.paper;
  let ink = isHex(c.ink) ? toHex(parseHex(c.ink)!) : STANDARD.ink;
  const accent = isHex(c.accent) ? toHex(parseHex(c.accent)!) : STANDARD.accent;
  const dark = luminance(paper) < 0.25;
  // ink too close to the paper (e.g. both light): the text would vanish, so it is pushed away
  if (contrast(ink, paper) < 3) ink = dark ? "#F2EFE8" : "#1C1C1E";
  const card = dark ? mix(paper, "#FFFFFF", 0.06) : mix(paper, "#FFFFFF", 0.55);
  return {
    paper,
    card,
    ink,
    inkSoft: mix(ink, paper, 0.35),
    faint: mix(ink, paper, 0.58),
    line: mix(ink, paper, 0.72),
    rule: mix(ink, paper, dark ? 0.84 : 0.86),
    accent,
    onAccent: contrast("#FFFFFF", accent) >= contrast("#1C1C1E", accent) ? "#FFFFFF" : "#1C1C1E",
    red: dark ? "#FF6B61" : "#C8372D",
    green: dark ? "#5FD08A" : "#2E8B4E",
    orange: dark ? "#FFB054" : "#C8730B",
    dark,
  };
}
