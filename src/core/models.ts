// Data model shared by the whole app (same shapes as the Obsidian plugin).

/** A notebook page: section, owner, notebook ("note"), page. */
export interface PageKey {
  section: number;
  owner: number;
  note: number;
  page: number;
}

/** Same id as the plugin: "section_owner_note_page" (e.g. "3_27_746_9"). */
export const pageId = (k: PageKey): string => `${k.section}_${k.owner}_${k.note}_${k.page}`;

export const parsePageId = (id: string): PageKey | null => {
  const p = id.split("_").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  return { section: p[0], owner: p[1], note: p[2], page: p[3] };
};

export const isValidKey = (k: PageKey): boolean => k.section >= 0 && k.owner >= 0 && k.note > 0 && k.page >= 0;

export const sameKey = (a: PageKey, b: PageKey): boolean =>
  a.section === b.section && a.owner === b.owner && a.note === b.note && a.page === b.page;

export const keyLabel = (k: PageKey): string => `${k.note}/${k.page}`;

/** A stroke, same format as the plugin: `pts` = [x, y, force, x, y, force, ...] in Ncode units. */
export interface Stroke {
  /** Pen-down time (ms since 1970, pen clock). Also used to recognise duplicates. */
  t: number;
  /** 0 = pen, 1 = eraser. */
  tip: number;
  /** Raw ARGB colour sent by the pen. */
  color: number;
  pts: number[];
}

export const pointCount = (s: Stroke): number => Math.floor(s.pts.length / 3);

/** Drops points with negative coordinates (like `cleanPts` in the plugin). */
export function cleaned(s: Stroke): Stroke {
  const out: number[] = [];
  for (let i = 0; i + 2 < s.pts.length; i += 3) {
    if (s.pts[i] >= 0 && s.pts[i + 1] >= 0) out.push(s.pts[i], s.pts[i + 1], s.pts[i + 2]);
  }
  return { ...s, pts: out };
}

/**
 * Removes isolated "jumping" points (like the live-stroke filter of the official SDK): a point that jumps more than
 * `delta` units away from both neighbours in the same direction, or that is outside the paper.
 */
export function despiked(s: Stroke, delta = 10): Stroke {
  const n = pointCount(s);
  if (n < 3) return s;
  const x = (i: number) => s.pts[i * 3];
  const y = (i: number) => s.pts[i * 3 + 1];
  const spike = (a: number, b: number, c: number) => b > a === b > c && Math.abs(b - a) > delta && Math.abs(b - c) > delta;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let bad = !(x(i) >= 1 && y(i) >= 1 && x(i) <= 15070 && y(i) <= 8480);
    if (!bad && i > 0 && i < n - 1) bad = spike(x(i - 1), x(i), x(i + 1)) || spike(y(i - 1), y(i), y(i + 1));
    if (!bad) out.push(s.pts[i * 3], s.pts[i * 3 + 1], s.pts[i * 3 + 2]);
  }
  return { ...s, pts: out };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Coordinates rounded to 2 decimals (lighter pages to upload, like the Bluefy page). */
export const rounded = (s: Stroke): Stroke => ({ ...s, pts: s.pts.map(r2) });

/** Everything the app knows about a page. */
export interface PageRecord {
  key: PageKey;
  /** Strokes sorted by time, no duplicates (from the pen's memory and live). */
  strokes: Stroke[];
  /** Strokes the pen declared at the last download from its memory (-1 = never). */
  penCount: number;
  /** Bytes the pen declared at the last download (-1 = never). */
  penBytes: number;
  /** Stroke count at the last successful upload to the PC (-1 = never uploaded). */
  sentCount: number;
  /** Last change (ms). */
  updated: number;
}

export const newRecord = (key: PageKey): PageRecord => ({ key, strokes: [], penCount: -1, penBytes: -1, sentCount: -1, updated: 0 });

/** Needs uploading: has strokes and they are not the ones already sent. */
export const needsUpload = (r: PageRecord): boolean => r.strokes.length > 0 && r.sentCount !== r.strokes.length;

/** Adds new strokes (recognised by pen-down time). Returns how many were really new. Mutates `r`. */
export function mergeStrokes(r: PageRecord, incoming: Stroke[]): number {
  const seen = new Set(r.strokes.map((s) => s.t));
  let added = 0;
  for (const s of incoming) {
    if (pointCount(s) < 1 || seen.has(s.t)) continue;
    r.strokes.push(s);
    seen.add(s.t);
    added++;
  }
  if (added > 0) {
    r.strokes.sort((a, b) => a.t - b.t);
    r.updated = Date.now();
  }
  return added;
}

/** What the pen says about itself when it connects. */
export interface PenVersion {
  deviceName: string;
  firmware: string;
  protocolVersion: string;
  subName: string;
  mac: string;
}

export interface PenSettings {
  locked: boolean;
  retryCount: number;
  resetCount: number;
  timestamp: number;
  autoShutdown: number;
  maxForce: number;
  usedMemory: number;
  capPowerOff: boolean;
  autoPowerOn: boolean;
  beep: boolean;
  hover: boolean;
  battery: number;
  offlineData: boolean;
}
