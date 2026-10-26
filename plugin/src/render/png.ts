// Disegna la pagina in un PNG da mandare al modello di trascrizione.
// - I tratti già trascritti sono grigi (contesto), quelli nuovi neri (da trascrivere).
// - Si può ritagliare attorno a una zona ("focus"): il corsivo arriva più grande e si legge meglio.
// - Dimensione mirata a ~1,15 megapixel, il formato che il modello usa senza ridimensionare.

import { Stroke } from "../types";
import { Bounds, strokeBounds } from "./svg";

export interface PngResult {
  base64: string;
  width: number;
  height: number;
  /** Da pixel dell'immagine a unità Ncode: x = px / scale + ox. */
  ox: number;
  oy: number;
  scale: number;
}

export const OLD_INK = "#a8a8a8";
export const NEW_INK = "#000000";
/** Cancellature misurate dai tratti: in rosso, così il modello non le scambia per spunte o sottolineature. */
export const STRIKE_INK = "#e00000";
/** Frecce di risposta misurate dai tratti: in blu, numerate all'inizio e alla fine. */
export const ARROW_INK = "#0050ff";

export interface Mark {
  x: number;
  y: number;
  label: string;
}

/** Tela su cui disegnare: in Obsidian un <canvas>; l'app del telefono (senza browser) ne mette una sua. */
export const canvasMaker: { create: (width: number, height: number) => HTMLCanvasElement } = {
  create: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

const TARGET_PIXELS = 1_150_000;
const MAX_SIDE = 1800;
const MAX_SCALE = 24; // px per unità Ncode (≈ 10 px/mm: il corsivo resta leggibile, l'immagine costa meno)

/** Allarga una zona di un margine, senza uscire dai limiti dati. */
export function expandBounds(b: Bounds, m: { x: number; top: number; bottom: number }, limit?: Bounds): Bounds {
  const r = { minX: b.minX - m.x, maxX: b.maxX + m.x, minY: b.minY - m.top, maxY: b.maxY + m.bottom };
  if (!limit) return r;
  return {
    minX: Math.max(r.minX, limit.minX),
    maxX: Math.min(r.maxX, limit.maxX),
    minY: Math.max(r.minY, limit.minY),
    maxY: Math.min(r.maxY, limit.maxY),
  };
}

function intersects(s: Stroke, b: Bounds): boolean {
  for (let i = 0; i < s.pts.length; i += 3) {
    const x = s.pts[i],
      y = s.pts[i + 1];
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return true;
  }
  return false;
}

export function renderStrokesPng(
  strokes: Stroke[],
  isNew: (s: Stroke) => boolean,
  maxForce = 1023,
  focus?: Bounds,
  isStrike: (s: Stroke) => boolean = () => false,
  isArrow: (s: Stroke) => boolean = () => false,
  marks: Mark[] = [],
  targetPixels = TARGET_PIXELS
): PngResult | null {
  let visible = strokes.filter((s) => s.tip !== 1 && s.pts.length >= 3);
  if (focus) visible = visible.filter((s) => isNew(s) || intersects(s, focus));
  const b = focus ?? strokeBounds(visible);
  if (!b || !visible.length) return null;

  const pad = 1.5; // unità Ncode
  const wU = b.maxX - b.minX + pad * 2;
  const hU = b.maxY - b.minY + pad * 2;
  const scale = Math.min(MAX_SCALE, Math.sqrt(targetPixels / (wU * hU)), MAX_SIDE / Math.max(wU, hU));
  const W = Math.max(64, Math.round(wU * scale));
  const H = Math.max(64, Math.round(hU * scale));

  const canvas = canvasMaker.create(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const ox = b.minX - pad;
  const oy = b.minY - pad;
  const X = (v: number) => (v - ox) * scale;
  const Y = (v: number) => (v - oy) * scale;

  // prima i vecchi, poi i nuovi sopra, le cancellature in cima
  const ordered = [
    ...visible.filter((s) => !isNew(s)),
    ...visible.filter((s) => isNew(s) && !isStrike(s)),
    ...visible.filter((s) => isNew(s) && isStrike(s)),
  ];
  for (const s of ordered) {
    const p = s.pts;
    const n = p.length / 3;
    ctx.strokeStyle = isNew(s) ? (isStrike(s) ? STRIKE_INK : isArrow(s) ? ARROW_INK : NEW_INK) : OLD_INK;
    let sum = 0;
    for (let i = 2; i < p.length; i += 3) sum += p[i];
    const avg = sum / n / (maxForce || 1023);
    // tratto ≈ 0,45 mm, leggermente più spesso con più pressione
    ctx.lineWidth = Math.max(2, 0.19 * scale * (0.75 + 0.5 * Math.min(1, avg)));
    ctx.beginPath();
    ctx.moveTo(X(p[0]), Y(p[1]));
    if (n === 1) {
      ctx.lineTo(X(p[0]) + 0.5, Y(p[1]));
    } else {
      // curve morbide tra i punti medi (come nell'SVG): il corsivo resta fluido
      for (let i = 1; i < n - 1; i++) {
        const mx = (p[i * 3] + p[(i + 1) * 3]) / 2;
        const my = (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2;
        ctx.quadraticCurveTo(X(p[i * 3]), Y(p[i * 3 + 1]), X(mx), Y(my));
      }
      ctx.lineTo(X(p[(n - 1) * 3]), Y(p[(n - 1) * 3 + 1]));
    }
    ctx.stroke();
  }

  // numeri delle frecce di risposta: un cerchietto blu col numero, a sinistra del punto
  const r = Math.max(9, 0.55 * scale);
  for (const m of marks) {
    const cx = X(m.x) - r * 1.3,
      cy = Y(m.y);
    if (cx < -r || cy < -r || cx > W + r || cy > H + r) continue;
    ctx.fillStyle = ARROW_INK;
    ctx.beginPath();
    ctx.arc(Math.max(r, cx), cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(m.label, Math.max(r, cx), cy + 1);
  }

  const url = canvas.toDataURL("image/png");
  return { base64: url.slice(url.indexOf(",") + 1), width: W, height: H, ox, oy, scale };
}
