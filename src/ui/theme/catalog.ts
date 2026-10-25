// The catalogue of the look: every drawn element of the app has a name here. The screens ask for a name (never a
// specific picture), so the look can change without touching the screens:
// - standard look: Francesco's drawings (until he draws one, the provisional drawing below is used);
// - your look: the drawings you make with the pen (step 2).
// When a screen needs a new element it is added here, and it shows up in the list of things to draw.
import { Stroke, arc, box, circle, line } from "./rough";

export type Group = "Navigazione" | "Attività" | "Calendario" | "Penna" | "Contorni" | "Simboli";

export interface Element {
  id: string;
  group: Group;
  /** What to draw (shown when you draw it with the pen). */
  label: string;
  /** Provisional drawing (100 × 100), until a real one is drawn. Empty for the outlines, drawn by the app. */
  strokes: Stroke[];
}

const dot = (x: number, y: number): Stroke => [[x, y]];
const pen: Stroke[] = [
  [[22, 88], [28, 66], [72, 22], [86, 36], [42, 80], [22, 88]],
  line(64, 30, 78, 44),
  line(28, 66, 42, 80),
];

export const CATALOG: Element[] = [
  // navigation
  { id: "tab.tasks", group: "Navigazione", label: "Scheda «Attività»", strokes: [box(12, 14, 22, 22, 3), [[16, 25], [22, 31], [32, 15]], line(46, 25, 88, 25), box(12, 58, 22, 22, 3), line(46, 69, 80, 69)] },
  { id: "tab.calendar", group: "Navigazione", label: "Scheda «Calendario»", strokes: [box(12, 20, 76, 68, 6), line(12, 38, 88, 38), line(32, 10, 32, 28), line(68, 10, 68, 28), dot(32, 55), dot(50, 55), dot(68, 55), dot(32, 72), dot(50, 72)] },
  { id: "tab.pen", group: "Navigazione", label: "Scheda «Penna»", strokes: pen },
  { id: "nav.back", group: "Navigazione", label: "Indietro", strokes: [[[60, 16], [32, 50], [60, 84]]] },
  { id: "nav.prev", group: "Navigazione", label: "Freccia a sinistra", strokes: [[[62, 18], [34, 50], [62, 82]]] },
  { id: "nav.next", group: "Navigazione", label: "Freccia a destra", strokes: [[[38, 18], [66, 50], [38, 82]]] },
  { id: "nav.down", group: "Navigazione", label: "Apri (freccia in giù)", strokes: [[[18, 36], [50, 66], [82, 36]]] },
  { id: "add", group: "Navigazione", label: "Aggiungi (+)", strokes: [line(50, 14, 50, 86), line(14, 50, 86, 50)] },
  { id: "close", group: "Navigazione", label: "Chiudi (×)", strokes: [line(22, 22, 78, 78), line(78, 22, 22, 78)] },

  // tasks
  { id: "check.empty", group: "Attività", label: "Casella vuota", strokes: [circle(50, 50, 38)] },
  { id: "check.done", group: "Attività", label: "Spunta (✓)", strokes: [[[16, 54], [40, 78], [86, 20]]] },
  { id: "priority", group: "Attività", label: "Bandierina della priorità", strokes: [line(26, 92, 26, 10), [[26, 14], [82, 22], [62, 38], [84, 52], [26, 50]]] },
  { id: "repeat", group: "Attività", label: "Si ripete", strokes: [arc(50, 50, 30, 200, 340), [[70, 32], [78, 40], [88, 30]], arc(50, 50, 30, 20, 160), [[30, 68], [22, 60], [12, 70]]] },
  { id: "inbox", group: "Attività", label: "Inbox", strokes: [[[12, 56], [30, 20], [70, 20], [88, 56], [88, 84], [12, 84], [12, 56]], [[12, 56], [34, 56], [40, 66], [60, 66], [66, 56], [88, 56]]] },
  { id: "project", group: "Attività", label: "Progetto (#)", strokes: [line(40, 12, 30, 88), line(70, 12, 60, 88), line(16, 36, 86, 36), line(14, 64, 84, 64)] },
  { id: "label", group: "Attività", label: "Etichetta", strokes: [[[14, 46], [46, 14], [86, 14], [86, 54], [54, 86], [14, 46]], circle(70, 30, 6)] },
  { id: "note", group: "Attività", label: "Nota", strokes: [[[22, 10], [64, 10], [82, 28], [82, 90], [22, 90], [22, 10]], [[64, 10], [64, 28], [82, 28]], line(34, 48, 70, 48), line(34, 64, 70, 64), line(34, 78, 56, 78)] },
  { id: "clock", group: "Attività", label: "Orario", strokes: [circle(50, 50, 38), [[50, 24], [50, 50], [68, 62]]] },
  { id: "nodate", group: "Attività", label: "Senza data", strokes: [circle(50, 52, 28), line(20, 88, 82, 14)] },
  { id: "completed", group: "Attività", label: "Completate", strokes: [circle(50, 50, 38), [[30, 52], [45, 67], [72, 34]]] },

  // calendar
  { id: "today", group: "Calendario", label: "Cerchio di «oggi»", strokes: [] },
  { id: "dot", group: "Calendario", label: "Pallino di un impegno", strokes: [] },
  { id: "now", group: "Calendario", label: "Linea di «adesso»", strokes: [] },

  // pen
  { id: "pen", group: "Penna", label: "Penna", strokes: pen },
  { id: "write", group: "Penna", label: "Scrivi pure", strokes: [...pen, [[8, 94], [22, 86], [36, 94], [50, 86]]] },
  { id: "bluetooth", group: "Penna", label: "Bluetooth", strokes: [[[28, 32], [70, 68], [50, 88], [50, 12], [70, 32], [28, 68]]] },
  { id: "battery", group: "Penna", label: "Batteria", strokes: [box(10, 30, 72, 40, 6), box(82, 42, 8, 16), line(22, 42, 22, 58), line(34, 42, 34, 58), line(46, 42, 46, 58)] },
  { id: "search", group: "Penna", label: "Cerca", strokes: [circle(42, 42, 26), line(61, 61, 88, 88)] },
  { id: "link", group: "Penna", label: "Collegamento", strokes: [line(16, 36, 82, 36), [[68, 22], [84, 36], [68, 50]], line(84, 64, 18, 64), [[32, 50], [16, 64], [32, 78]]] },
  { id: "download", group: "Penna", label: "Scarico", strokes: [line(50, 12, 50, 74), [[26, 52], [50, 76], [74, 52]], line(18, 90, 82, 90)] },
  { id: "ok", group: "Penna", label: "Tutto a posto", strokes: [circle(50, 50, 38), [[30, 52], [45, 67], [72, 34]]] },
  { id: "error", group: "Penna", label: "Errore", strokes: [circle(50, 50, 38), line(34, 34, 66, 66), line(66, 34, 34, 66)] },
  { id: "wait", group: "Penna", label: "Attesa", strokes: [dot(24, 54), dot(50, 54), dot(76, 54)] },
  { id: "question", group: "Penna", label: "Punto di domanda", strokes: [[...arc(50, 34, 20, 200, 400), [50, 62]], dot(50, 84)] },
  { id: "lock", group: "Penna", label: "Lucchetto", strokes: [box(22, 46, 56, 42, 6), [[32, 46], [32, 32], ...arc(50, 32, 18, 180, 360), [68, 46]]] },
  { id: "settings", group: "Penna", label: "Impostazioni", strokes: [circle(50, 50, 13), circle(50, 50, 28), ...Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; return line(50 + Math.cos(a) * 28, 50 + Math.sin(a) * 28, 50 + Math.cos(a) * 40, 50 + Math.sin(a) * 40); })] },
  { id: "log", group: "Penna", label: "Registro", strokes: [dot(16, 24), line(30, 24, 86, 24), dot(16, 50), line(30, 50, 78, 50), dot(16, 76), line(30, 76, 84, 76)] },
  { id: "palette", group: "Penna", label: "Aspetto (tavolozza)", strokes: [circle(50, 50, 38, 34), circle(64, 66, 8), dot(32, 40), dot(52, 28), dot(72, 40), dot(30, 60)] },

  // outlines (drawn by the app from your stroke; you will draw one sample of each)
  { id: "rule", group: "Contorni", label: "Linea di separazione", strokes: [] },
  { id: "frame", group: "Contorni", label: "Riquadro", strokes: [] },
  { id: "button", group: "Contorni", label: "Pulsante", strokes: [] },
  { id: "switch", group: "Contorni", label: "Interruttore", strokes: [] },

  // symbols missing from the font
  { id: "sym.middot", group: "Simboli", label: "Puntino (·)", strokes: [dot(50, 50)] },
  { id: "sym.dash", group: "Simboli", label: "Lineetta (–)", strokes: [line(20, 52, 80, 50)] },
];

export const ELEMENT = new Map(CATALOG.map((e) => [e.id, e]));
export type ElementId = (typeof CATALOG)[number]["id"];
