// The drawings of the look: the standard ones (Francesco's, in the app) and yours (made with the pen, saved on this
// phone in disegni.json). Which ones are used is chosen in Aspetto → Disegni.
import { readJson, writeJson } from "../../app/files";
import type { Pt } from "./rough";
import { STANDARD_DRAWINGS } from "./standard";
import { theme } from "./theme";

export interface Drawing {
  /** Strokes in a 100 × 100 box. */
  strokes: Pt[][];
  /** For the line ("rule"): how it leaves the straight line (see core/drawing.ts lineProfile). */
  profile?: number[];
}

const FILE = "disegni.json";
let mine: Record<string, Drawing> = readJson<Record<string, Drawing>>(FILE, {});

export const drawings = {
  /** The drawing used now for an element, or null (then the provisional one). */
  get(id: string): Drawing | null {
    if (theme.look.drawings === "mine" && mine[id]) return mine[id];
    return STANDARD_DRAWINGS[id] ?? null;
  },
  mine(id: string): Drawing | null {
    return mine[id] ?? null;
  },
  standard(id: string): Drawing | null {
    return STANDARD_DRAWINGS[id] ?? null;
  },
  countMine(): number {
    return Object.keys(mine).length;
  },
  save(id: string, d: Drawing): void {
    mine = { ...mine, [id]: d };
    writeJson(FILE, mine);
    // a drawing made now is to be seen: your drawings become the ones in use
    if (theme.look.drawings !== "mine") theme.set({ drawings: "mine" });
    else theme.bump();
  },
  remove(id: string): void {
    const { [id]: _, ...rest } = mine;
    mine = rest;
    writeJson(FILE, mine);
    theme.bump();
  },
  /** All your drawings as JSON (to make them the standard ones of the app). */
  exportMine(): string {
    return JSON.stringify(mine);
  },
};
