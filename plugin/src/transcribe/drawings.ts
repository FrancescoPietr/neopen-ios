// Disegni dentro la trascrizione: Claude indica dove sta il disegno e dove stanno le scritte che lo accompagnano
// (nomi, #tag, parole in fondo a una freccia); qui si ritrovano i tratti esatti e si crea un SVG del disegno
// in cui le scritte a mano diventano testo battuto, nella stessa posizione.

import { PngResult } from "../render/png";
import { Bounds, strokeBounds, strokePath, strokeWidth } from "../render/svg";
import { Stroke } from "../types";

/** Come risponde Claude: rettangoli in pixel dell'immagine che ha visto ([x0, y0, x1, y1]). */
export interface DrawingSpec {
  box: number[];
  labels: { text: string; box: number[] }[];
  /** Dove sta il testo scritto accanto al disegno, e quante righe sono. */
  text_side?: "left" | "right" | "none";
  lines_beside?: number;
}

/** Testo accanto al disegno: da che parte (rispetto al disegno) e quante righe. */
export interface Beside {
  side: "left" | "right";
  lines: number;
  /** Grandezza delle prime righe accanto rispetto al testo normale (1 = normale), come scritte sulla carta. */
  sizes?: number[];
}

export interface PlacedLabel {
  text: string;
  bounds: Bounds;
}

export interface PlacedDrawing {
  strokes: Stroke[];
  labels: PlacedLabel[];
  bounds: Bounds;
  beside?: Beside;
  /** Posizione nella lista di Claude (per "[[drawing N]]"). */
  index: number;
  /** I tratti delle sue scritte. */
  labelStrokes?: Stroke[];
}

/** Rettangolo in pixel → unità Ncode (ordinato, anche se Claude scambia gli angoli). */
export function boxToNcode(box: number[], png: Pick<PngResult, "ox" | "oy" | "scale">): Bounds | null {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => !Number.isFinite(Number(v)))) return null;
  const [a, b, c, d] = box.map(Number);
  const X = (v: number) => v / png.scale + png.ox;
  const Y = (v: number) => v / png.scale + png.oy;
  return { minX: X(Math.min(a, c)), minY: Y(Math.min(b, d)), maxX: X(Math.max(a, c)), maxY: Y(Math.max(b, d)) };
}

const grow = (b: Bounds, m: number): Bounds => ({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });
const union = (a: Bounds, b: Bounds): Bounds => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});
const inside = (x: number, y: number, b: Bounds) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

function center(s: Stroke): { x: number; y: number } {
  const b = strokeBounds([s])!;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Quota dei punti del tratto dentro il rettangolo. */
function share(s: Stroke, b: Bounds): number {
  let n = 0,
    tot = 0;
  for (let i = 0; i + 1 < s.pts.length; i += 3) {
    tot++;
    if (inside(s.pts[i], s.pts[i + 1], b)) n++;
  }
  return tot ? n / tot : 0;
}

/**
 * Ritrova i tratti: quelli delle scritte (centro nel rettangolo della scritta) e quelli del disegno
 * (per la maggior parte nel rettangolo del disegno, oppure nello spazio fra il disegno e le sue scritte, come le frecce).
 * Ogni tratto appartiene a un solo disegno. Disegni senza tratti si scartano.
 */
export function placeDrawings(specs: DrawingSpec[], png: Pick<PngResult, "ox" | "oy" | "scale">, candidates: Stroke[]): PlacedDrawing[] {
  const used = new Set<Stroke>();
  const out: PlacedDrawing[] = [];
  for (const [index, spec] of specs.entries()) {
    const area = boxToNcode(spec.box, png);
    if (!area) continue;
    const labelStrokes = new Set<Stroke>();
    const labels = placeLabels(spec.labels ?? [], png, candidates, used, labelStrokes, candidates.filter((s) => !used.has(s) && share(s, area) >= 0.8));
    // fra il disegno e le sue scritte (frecce, linee di richiamo): l'area del disegno allargata fino alle scritte
    let reach = grow(area, 1.2);
    for (const l of labels) reach = union(reach, l.bounds);
    const free = (s: Stroke) => !used.has(s) && !labelStrokes.has(s);
    const strokes = candidates.filter((s) => {
      if (!free(s)) return false;
      if (share(s, grow(area, 1.2)) >= 0.6) return true;
      // fuori dal disegno ma tutto nella zona delle sue scritte: freccia o linea di richiamo
      return labels.length > 0 && share(s, reach) >= 0.95 && !inside(center(s).x, center(s).y, grow(area, 1.2)) && isConnector(s, area, labels);
    });
    // il rettangolo di Claude è approssimato (a volte taglia un pezzo del disegno): si aggiungono i tratti
    // attaccati al disegno (a meno di 0,8 unità), purché restino vicini al rettangolo (al massimo quanto la sua misura)
    const w = area.maxX - area.minX,
      h = area.maxY - area.minY;
    const limit = { minX: area.minX - Math.max(4, w), maxX: area.maxX + Math.max(4, w), minY: area.minY - Math.max(4, h), maxY: area.maxY + Math.max(4, h) };
    const boxes = new Map<Stroke, Bounds>();
    const bx = (s: Stroke) => boxes.get(s) ?? (boxes.set(s, strokeBounds([s])!), boxes.get(s)!);
    const near = (a: Bounds, b: Bounds, gap: number) => a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY;
    const members = new Set(strokes);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of candidates) {
        if (members.has(s) || !free(s) || share(s, limit) < 0.9) continue;
        const b = bx(s);
        for (const m of members) {
          if (near(b, bx(m), 0.8) && touches(s, m, 0.8)) {
            members.add(s);
            strokes.push(s);
            grew = true;
            break;
          }
        }
      }
    }
    if (!strokes.length) continue;
    for (const s of [...strokes, ...labelStrokes]) used.add(s);
    let bounds = strokeBounds(strokes)!;
    for (const l of labels) bounds = union(bounds, l.bounds);
    const side = spec.text_side;
    const n = Math.round(Number(spec.lines_beside) || 0);
    out.push({ index, strokes, labels, bounds, labelStrokes: [...labelStrokes], beside: (side === "left" || side === "right") && n > 0 ? { side, lines: n } : undefined });
  }
  return out;
}

/** Ritrova i tratti delle scritte (rettangoli di Claude in pixel) fra i candidati; li aggiunge a labelStrokes. */
export function placeLabels(
  specLabels: { text: string; box: number[]; arrow?: number[]; line_boxes?: number[][] }[],
  png: Pick<PngResult, "ox" | "oy" | "scale">,
  candidates: Stroke[],
  used: Set<Stroke>,
  labelStrokes: Set<Stroke>,
  /** I tratti del disegno: quelli che partono da lì e ne escono (frecce e linee verso le note) non sono lettere. */
  drawing?: Stroke[]
): PlacedLabel[] {
  const db = drawing?.length ? strokeBounds(drawing) : null;
  const dpts: number[] = [];
  for (const d of drawing ?? []) for (let i = 0; i + 1 < d.pts.length; i += 6) dpts.push(d.pts[i], d.pts[i + 1]);
  const nearDrawing = (x: number, y: number) => {
    for (let i = 0; i < dpts.length; i += 2) if ((dpts[i] - x) ** 2 + (dpts[i + 1] - y) ** 2 < 2.5 * 2.5) return true;
    return false;
  };
  const drawingSet = new Set(drawing ?? []);
  const sbox = new Map<Stroke, Bounds>();
  const bx = (s: Stroke) => sbox.get(s) ?? (sbox.set(s, strokeBounds([s])!), sbox.get(s)!);
  // i tratti del disegno che si toccano formano gruppi: il corpo del disegno è un gruppo grande; una freccia con la sua
  // punta (e la lettera che le si attacca in fondo) è un gruppo piccolo
  const compSize = new Map<Stroke, number>();
  {
    const arr = [...drawingSet];
    const parent = arr.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < arr.length; i++) {
      const p = bx(arr[i]);
      for (let j = i + 1; j < arr.length; j++) {
        const q = bx(arr[j]);
        if (q.minX - 0.3 > p.maxX || p.minX - 0.3 > q.maxX || q.minY - 0.3 > p.maxY || p.minY - 0.3 > q.maxY) continue;
        if (find(i) !== find(j) && touches(arr[i], arr[j], 0.3)) parent[find(i)] = find(j);
      }
    }
    const count = new Map<number, number>();
    arr.forEach((_, i) => count.set(find(i), (count.get(find(i)) ?? 0) + 1));
    arr.forEach((s, i) => compSize.set(s, count.get(find(i)) ?? 1));
  }
  const inBody = (s: Stroke) => (compSize.get(s) ?? 0) >= 8;
  // il centro di un rettangolo (senza i bordi, dove Claude spesso include un pezzo di freccia o di disegno)
  const core = (b: Bounds): Bounds => {
    const dx = (b.maxX - b.minX) * 0.1,
      dy = (b.maxY - b.minY) * 0.2;
    return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX - dx, maxY: b.maxY - dy };
  };
  const labelBoxes = specLabels.map((l) => boxToNcode(l?.box, png)).filter((b): b is Bounds => !!b);
  // le lettere attaccate alla coda di una freccia: la freccia è un tratto lungo che ha un capo a ridosso del corpo del
  // disegno (la punta) e uno lontano; quello che si attacca al capo lontano è la scrittura (la f di «fare»)
  const bodyPts: number[] = [];
  for (const d of drawing ?? []) if (inBody(d)) for (let i = 0; i + 1 < d.pts.length; i += 6) bodyPts.push(d.pts[i], d.pts[i + 1]);
  const distBody = (x: number, y: number) => {
    let m = Infinity;
    for (let i = 0; i < bodyPts.length; i += 2) m = Math.min(m, (bodyPts[i] - x) ** 2 + (bodyPts[i + 1] - y) ** 2);
    return Math.sqrt(m);
  };
  const tailLetters = new Set<Stroke>();
  for (const c of drawing ?? []) {
    const bc = bx(c);
    if (inBody(c) || Math.max(bc.maxX - bc.minX, bc.maxY - bc.minY) < 3.5) continue;
    const n = Math.floor(c.pts.length / 3);
    const ends = [
      { x: c.pts[0], y: c.pts[1] },
      { x: c.pts[(n - 1) * 3], y: c.pts[(n - 1) * 3 + 1] },
    ];
    const far = distBody(ends[0].x, ends[0].y) > distBody(ends[1].x, ends[1].y) ? ends[0] : ends[1];
    for (const t of candidates) {
      if (t === c) continue;
      for (let i = 0; i + 1 < t.pts.length; i += 3) {
        if ((t.pts[i] - far.x) ** 2 + (t.pts[i + 1] - far.y) ** 2 < 3.2) {
          tailLetters.add(t);
          break;
        }
      }
    }
  }
  // (e le lettere piccole attaccate a quelle: la seconda parte di una f)
  for (const t of [...tailLetters]) {
    for (const u of candidates) {
      if (tailLetters.has(u) || u === t) continue;
      const b = bx(u);
      if (Math.max(b.maxX - b.minX, b.maxY - b.minY) >= 3.3) continue;
      if (touches(u, t, 0.8)) tailLetters.add(u);
    }
  }
  const rowBoxes: Bounds[] = specLabels.flatMap((l) => {
    const lbs = (l?.line_boxes ?? []).map((b) => boxToNcode(b, png)).filter((b): b is Bounds => !!b);
    return lbs.length ? lbs : [boxToNcode(l?.box, png)].filter((b): b is Bounds => !!b);
  });
  const isArrow = (s: Stroke): boolean => {
    if (!db) return false;
    const n = Math.floor(s.pts.length / 3);
    if (n < 2) return false;
    // una lettera vicino al disegno non è una freccia: le frecce sono lunghe e stanno fuori dalle parole
    const sb = strokeBounds([s])!;
    if (Math.max(sb.maxX - sb.minX, sb.maxY - sb.minY) < 2) return false;
    if (labelBoxes.some((lb) => share(s, core(lb)) >= 0.5)) return false;
    // dentro il rettangolo stretto di una riga di scrittura (la f di «fare» che finisce la freccia) non è una freccia
    const c0 = center(s);
    if (tailLetters.has(s) && rowBoxes.some((rb) => inside(c0.x, c0.y, grow(rb, 0.3)))) return false;
    // un capo del tratto arriva a ridosso dei tratti del disegno (la punta di una freccia, l'attacco di una linea)…
    if (!nearDrawing(s.pts[0], s.pts[1]) && !nearDrawing(s.pts[(n - 1) * 3], s.pts[(n - 1) * 3 + 1])) return false;
    // …e il tratto esce dal disegno (non è un dettaglio dentro il disegno)
    let out = 0;
    for (let i = 0; i + 1 < s.pts.length; i += 3) if (!inside(s.pts[i], s.pts[i + 1], db)) out++;
    return out / n >= 0.3;
  };
  // le frecce indicate da Claude: tratti quasi tutti nel rettangolo della freccia e per lo più fuori dalle parole
  const arrowBoxes = specLabels
    .map((l) => ({ ab: l?.arrow && l.arrow.length === 4 ? boxToNcode(l.arrow, png) : null, lb: boxToNcode(l?.box, png) }))
    .filter((x): x is { ab: Bounds; lb: Bounds | null } => !!x.ab);
  const inArrow = (s: Stroke) => {
    if (!arrowBoxes.some(({ ab, lb }) => share(s, grow(ab, 0.5)) >= 0.7 && (!lb || share(s, lb) < 0.5))) return false;
    // una freccia è una linea lunga, o la punta a ridosso del disegno: una lettera alta (la f di «fare») che finisce
    // dentro il rettangolo della freccia non lo è
    const b = strokeBounds([s])!;
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) >= 3.3) return true;
    const n = Math.floor(s.pts.length / 3);
    return n >= 2 && (nearDrawing(s.pts[0], s.pts[1]) || nearDrawing(s.pts[(n - 1) * 3], s.pts[(n - 1) * 3 + 1]));
  };
  candidates = candidates.filter((s) => !isArrow(s) && !inArrow(s));
  // una nota di più righe con il rettangolo di ogni riga (line_boxes): ogni riga è una scritta a sé, col suo
  // rettangolo stretto (come «Prometheus»): i tratti si ritrovano riga per riga, senza pescare fuori
  // (i tratti del disegno contano solo se stanno ben dentro il rettangolo della scritta: un rettangolo un po' largo
  // di Claude non deve portarsi via un pezzo del disegno)
  const attachedOutside = (s: Stroke, area: Bounds): boolean => {
    const b = bx(s);
    for (const d of drawingSet) {
      if (d === s || !inBody(d)) continue;
      const q = bx(d);
      if (q.minX - 0.3 > b.maxX || b.minX - 0.3 > q.maxX || q.minY - 0.3 > b.maxY || b.minY - 0.3 > q.maxY) continue;
      const c = center(d);
      if (!inside(c.x, c.y, area) && touches(s, d, 0.3)) return true;
    }
    return false;
  };
  // un tratto del disegno che ha l'aspetto del tratteggio (dritto, lungo) o è molto lungo non è una lettera
  const chord = (s: Stroke): number => {
    let L = 0;
    for (let i = 3; i + 2 < s.pts.length; i += 3) L += Math.hypot(s.pts[i] - s.pts[i - 3], s.pts[i + 1] - s.pts[i - 2]);
    const n = s.pts.length;
    return L ? Math.hypot(s.pts[n - 3] - s.pts[0], s.pts[n - 2] - s.pts[1]) / L : 1;
  };
  const bodyLike = (s: Stroke): boolean => {
    if (!drawingSet.has(s) || tailLetters.has(s)) return false;
    const b = bx(s);
    const e = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    return e > 4.5 || (e >= 1.3 && chord(s) > 0.85);
  };
  const specs = specLabels
    .flatMap((l, ni) => {
      const text = String(l?.text ?? "").trim();
      const rows = text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
      const lbs = (l?.line_boxes ?? []).map((b) => boxToNcode(b, png));
      const nb = boxToNcode(l?.box, png);
      if (rows.length > 1 && nb) {
        // le righe vere della carta, dai tratti stessi (il profilo verticale dell'inchiostro): Claude a volte
        // unisce due righe andate a capo, o sbaglia i rettangoli delle righe
        // (il rettangolo della nota è spesso largo: se ci sono i rettangoli delle righe si usa la loro unione)
        const lbOk = lbs.length >= 1 && lbs.every(Boolean);
        const area = grow(lbOk ? (lbs as Bounds[]).reduce((u, b) => union(u, b)) : nb, 0.6);
        const inNote = candidates.filter((s) => {
          if (used.has(s) || labelStrokes.has(s)) return false;
          const c = center(s);
          if (!inside(c.x, c.y, area)) return false;
          return !bodyLike(s) && !(drawingSet.has(s) && attachedOutside(s, area));
        });
        const bands = inNote.length >= 6 ? rowBands(inNote) : [];
        const claudeOk = lbs.length === rows.length && lbs.every(Boolean);
        if (bands.length >= 2 && (!claudeOk || bands.length !== rows.length)) {
          const widths = bands.map((bd) => {
            const m = inNote.filter((s) => {
              const c = center(s);
              return c.y >= bd.minY && c.y <= bd.maxY;
            });
            const b = m.length ? strokeBounds(m)! : nb;
            return Math.max(0.5, b.maxX - b.minX);
          });
          const texts = assignRows(rows, widths)?.texts;
          if (texts) {
            const nx = strokeBounds(inNote)!;
            return texts
              .map((t, i) => ({ text: t, lb: { minX: nx.minX - 0.5, maxX: nx.maxX + 0.5, minY: bands[i].minY, maxY: bands[i].maxY }, note: ni, row: true }))
              .filter((x) => x.text);
          }
        }
        if (claudeOk) return rows.map((t, i) => ({ text: t, lb: lbs[i] as Bounds, note: ni, row: true }));
        // senza i rettangoli delle righe: il rettangolo della nota diviso in righe uguali
        const h = (nb.maxY - nb.minY) / rows.length;
        return rows.map((t, i) => ({ text: t, lb: { minX: nb.minX, maxX: nb.maxX, minY: nb.minY + i * h, maxY: nb.minY + (i + 1) * h }, note: ni, row: true }));
      }
      return [{ text, lb: nb, note: ni, row: false }];
    })
    .filter((x): x is { text: string; lb: Bounds; note: number; row: boolean } => !!x.text && !!x.lb);
  // 1. ogni tratto va alla riga più vicina fra quelle il cui rettangolo (un po' allargato) contiene il suo centro:
  //    con righe vicine (un elenco) un tratto non finisce nella riga sbagliata solo perché viene prima
  //    I tratti del disegno contano solo se stanno ben dentro il rettangolo della scritta (non sul bordo):
  //    un rettangolo un po' largo di Claude non deve portarsi via un pezzo del disegno.
  const mine: Stroke[][] = specs.map(() => []);
  for (const s of candidates) {
    if (used.has(s) || labelStrokes.has(s)) continue;
    const c = center(s);
    let best = -1,
      bestD = Infinity;
    specs.forEach((sp, i) => {
      if (!inside(c.x, c.y, grow(sp.lb, 0.6))) return;
      // sul bordo del rettangolo e attaccato al resto del disegno (fuori dalla scritta): è il disegno
      if (drawingSet.has(s) && !inside(c.x, c.y, core(sp.lb)) && attachedOutside(s, grow(sp.lb, 0.6))) return;
      if (sp.row && bodyLike(s)) return;
      const h = Math.max(0.5, sp.lb.maxY - sp.lb.minY);
      const d = Math.abs(c.y - (sp.lb.minY + sp.lb.maxY) / 2) / h + Math.max(0, sp.lb.minX - c.x, c.x - sp.lb.maxX) / 10;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) mine[best].push(s);
  }
  // 2. tratti molto più alti della riga (una freccia o una linea che passa di lì) non sono lettere: restano liberi
  //    (così la freccia diventa parte del disegno e la scritta ha la sua grandezza vera)
  specs.forEach((sp, i) => {
    if (sp.row) {
      // riga di una nota (rettangolo stretto di Claude): tutto quello che c'è è scrittura, anche una f alta
      for (const s of mine[i]) labelStrokes.add(s);
      return;
    }
    const hs = mine[i].map((s) => {
      const b = strokeBounds([s])!;
      return b.maxY - b.minY;
    });
    const med = Math.max(0.4, [...hs].sort((x, y) => x - y)[Math.floor(hs.length / 2)] ?? 0);
    // molto più alto delle lettere (anche di una f o una l in corsivo) e per lo più fuori dalla scritta: una linea
    mine[i] = mine[i].filter((s, k) => !(hs[k] > Math.max(3.5 * med, 2) && share(s, core(sp.lb)) < 0.5));
    for (const s of mine[i]) labelStrokes.add(s);
  });
  // 3. pezzi della scritta rimasti appena fuori dal rettangolo (es. il "#" davanti alla parola): tratti piccoli
  //    sulla stessa riga, attaccati a destra o a sinistra
  const labels: PlacedLabel[] = [];
  //    Solo per le scritte di una riga, solo di lato (mai sopra o sotto) e mai dentro il disegno.
  specs.forEach((sp, i) => {
    const m = mine[i];
    if (m.length && !sp.text.includes("\n")) {
      const row = strokeBounds(m)!;
      const lineH = row.maxY - row.minY;
      for (let k = 0; k < 6; k++) {
        const wb = strokeBounds(m)!;
        let grew = false;
        for (const s of candidates) {
          if (used.has(s) || labelStrokes.has(s)) continue;
          const b = strokeBounds([s])!;
          // un tratto lungo (tratteggio, freccia) non è un pezzo di scritta; una lettera alta (f, l) che tocca la
          // freccia sì, se sta sulla riga e attaccata alla scrittura
          const tail = tailLetters.has(s);
          const long = !tail && (Math.max(b.maxX - b.minX, b.maxY - b.minY) >= 3.3 || (drawingSet.has(s) && (inBody(s) || bodyLike(s))));
          // un tratto del disegno attaccato ad altri tratti del disegno (come il tratteggio) non è un pezzo di scritta
          if (!tail && drawingSet.has(s) && (drawing ?? []).some((d) => d !== s && !labelStrokes.has(d) && touches(s, d, 0.3))) continue;
          const small = !long;
          const cy = (b.minY + b.maxY) / 2;
          const withinRow = tail
            ? b.minY >= row.minY - 1.5 * lineH && b.maxY <= row.maxY + 2.5 * lineH
            : cy >= row.minY - 0.4 * lineH && cy <= row.maxY + 0.4 * lineH && b.minY >= row.minY - 1.2 * lineH && b.maxY <= row.maxY + 1.2 * lineH;
          const gapX = Math.max(wb.minX - b.maxX, b.minX - wb.maxX);
          if (small && withinRow && gapX < 1.3) {
            m.push(s);
            labelStrokes.add(s);
            grew = true;
          }
        }
        if (!grew) break;
      }
    }
    // la posizione vera della scritta è quella dei suoi tratti (Claude dà un rettangolo approssimato);
    // una nota di più righe diventa una scritta per riga, ognuna sulla sua riga di tratti
    if (!sp.row) labels.push(...splitIntoLines(sp.text, m, sp.lb));
    else labels.push({ text: sp.text, bounds: (m.length && strokeBounds(m)) || sp.lb });
  });
  // le righe di una stessa nota hanno tutte la stessa grandezza (come sulla carta): l'altezza tipica delle sue
  // righe, centrata su ogni riga (una riga con una f lunga o una g non diventa più grande delle altre)
  const byNote = new Map<number, number[]>();
  specs.forEach((sp, i) => {
    if (sp.row) byNote.set(sp.note, [...(byNote.get(sp.note) ?? []), i]);
  });
  for (const idx of byNote.values()) {
    const hs = idx
      .filter((i) => mine[i].length)
      .map((i) => {
        // altezza della riga senza le lettere che scendono o salgono molto: la mediana dei tratti, più margine
        const ys = mine[i].map((s) => strokeBounds([s])!).map((b) => b.maxY - b.minY).sort((a, b) => a - b);
        return Math.max(ys[Math.floor(ys.length / 2)] * 1.6, labels[i].bounds.maxY - labels[i].bounds.minY > 0 ? Math.min(labels[i].bounds.maxY - labels[i].bounds.minY, ys[Math.floor(ys.length / 2)] * 2.4) : 0);
      })
      .sort((a, b) => a - b);
    if (!hs.length) continue;
    // e mai più piccola di quanto dice la distanza fra le righe della nota
    const cys = idx.filter((i) => mine[i].length).map((i) => {
      const cs = mine[i].map((s) => center(s).y).sort((a, b) => a - b);
      return cs[Math.floor(cs.length / 2)];
    });
    const pitches = cys.slice(1).map((y, k) => y - cys[k]).filter((d) => d > 0).sort((a, b) => a - b);
    const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
    const H = Math.max(hs[Math.floor(hs.length / 2)], pitch * 0.85);
    for (const i of idx) {
      let b = labels[i].bounds;
      if (mine[i].length >= 2) {
        // dove comincia la riga: senza un tratto staccato dal resto a sinistra (un pezzo di freccia), ma con il
        // trattino di un elenco (vicino alla parola)
        const bs = mine[i].map((s) => bx(s)).sort((a, c) => a.minX - c.minX);
        let k = 0;
        while (k < bs.length - 1 && bs[k + 1].minX - bs[k].maxX > 2.5) k++;
        b = { ...b, minX: bs[k].minX };
      }
      const cs = mine[i].map((s) => center(s).y).sort((a, b2) => a - b2);
      const cy = cs.length ? cs[Math.floor(cs.length / 2)] : (b.minY + b.maxY) / 2;
      labels[i] = { text: labels[i].text, bounds: { minX: b.minX, maxX: b.maxX, minY: cy - H / 2, maxY: cy + H / 2 } };
    }
  }
  return labels;
}

/**
 * Le righe di scrittura di un gruppo di tratti, dal profilo verticale dell'inchiostro: le righe sono i picchi, le
 * valli profonde fra un picco e l'altro le separano (le discendenti che toccano la riga sotto non la fondono).
 */
export function rowBands(strokes: Stroke[]): { minY: number; maxY: number }[] {
  const b = strokeBounds(strokes);
  if (!b) return [];
  const BIN = 0.1;
  const n = Math.ceil((b.maxY - b.minY) / BIN) + 1;
  const raw = new Array<number>(n).fill(0);
  const bin = (y: number) => Math.min(n - 1, Math.max(0, Math.floor((y - b.minY) / BIN)));
  for (const s of strokes) {
    for (let i = 0; i + 4 < s.pts.length; i += 3) {
      const a = bin(s.pts[i + 1]),
        c = bin(s.pts[i + 4]);
      const lo = Math.min(a, c),
        hi = Math.max(a, c);
      for (let k = lo; k <= hi; k++) raw[k] += 1 / (hi - lo + 1);
    }
  }
  const R = 2;
  const d = raw.map((_, i) => {
    let t = 0,
      m = 0;
    for (let k = Math.max(0, i - R); k <= Math.min(n - 1, i + R); k++) {
      t += raw[k];
      m++;
    }
    return t / m;
  });
  const max = Math.max(...d);
  if (!(max > 0)) return [];
  // valli: minimi locali; una valle separa due righe se è molto più bassa dei picchi ai suoi lati
  const splits: number[] = [];
  let peak = 0;
  let start = 0;
  for (let i = 1; i < n - 1; i++) {
    peak = Math.max(peak, d[i]);
    if (d[i] <= d[i - 1] && d[i] < d[i + 1] + 1e-9) {
      // picco a destra della valle
      let right = 0;
      for (let k = i; k < n; k++) {
        right = Math.max(right, d[k]);
        if (d[k] < d[i] * 0.5 && k > i + 2) break;
      }
      const leftPeak = Math.max(...d.slice(start, i + 1));
      if (d[i] < 0.5 * Math.min(leftPeak, right) && Math.min(leftPeak, right) > 0.25 * max) {
        splits.push(i);
        start = i;
        peak = 0;
        i += 2;
      }
    }
  }
  const cuts = [0, ...splits, n - 1];
  const out: { minY: number; maxY: number }[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    // l'estremo vero dell'inchiostro nella fascia
    let lo = cuts[k],
      hi = cuts[k + 1];
    while (lo < hi && d[lo] < 0.06 * max) lo++;
    while (hi > lo && d[hi] < 0.06 * max) hi--;
    if (hi - lo < 3) continue;
    out.push({ minY: k === 0 ? b.minY + lo * BIN : b.minY + cuts[k] * BIN, maxY: k === cuts.length - 2 ? b.minY + (hi + 1) * BIN : b.minY + cuts[k + 1] * BIN });
  }
  return out;
}

/**
 * Il testo di una nota (le righe di Claude) sulle righe vere della carta, di cui si conosce la larghezza: una riga
 * di Claude che sulla carta va a capo occupa più righe (le sue parole si dividono in proporzione alla larghezza).
 * null se le righe vere sono meno di quelle di Claude.
 */
export function assignRows(lines: string[], widths: number[], groups?: number[]): { texts: string[]; cost: number } | null {
  const L = lines.length,
    R = widths.length;
  if (R < L || !L) return null;
  const totalChars = lines.reduce((n, t) => n + t.length, 0);
  const cpw = totalChars / widths.reduce((a, b) => a + b, 0);
  const pre = [0];
  for (const w of widths) pre.push(pre[pre.length - 1] + w);
  // un segmento di righe vere non attraversa due gruppi (due note diverse)
  const sameGroup = (a: number, b: number) => !groups || groups.slice(a, b).every((g) => g === groups[a]);
  // dp[l][r]: costo minimo con le prime l righe di Claude sulle prime r righe vere
  const INF = 1e9;
  const dp = Array.from({ length: L + 1 }, () => new Array<number>(R + 1).fill(INF));
  const from = Array.from({ length: L + 1 }, () => new Array<number>(R + 1).fill(0));
  dp[0][0] = 0;
  for (let l = 1; l <= L; l++)
    for (let r = l; r <= R; r++)
      for (let a = l - 1; a < r; a++) {
        if (dp[l - 1][a] >= INF || !sameGroup(a, r)) continue;
        const k = r - a;
        const want = lines[l - 1].length;
        const have = (pre[r] - pre[a]) * cpw;
        // più righe vere per una riga corta sono improbabili: pesa di più il difetto
        const cost = Math.abs(have - want) / Math.max(6, want) + (k > 1 ? 0.15 * (k - 1) : 0);
        if (dp[l - 1][a] + cost < dp[l][r]) {
          dp[l][r] = dp[l - 1][a] + cost;
          from[l][r] = a;
        }
      }
  if (dp[L][R] >= INF) return null;
  const out: string[] = [];
  let r = R;
  const parts: { l: number; a: number; b: number }[] = [];
  for (let l = L; l >= 1; l--) {
    parts.unshift({ l: l - 1, a: from[l][r], b: r });
    r = from[l][r];
  }
  for (const p of parts) {
    const k = p.b - p.a;
    if (k === 1) {
      out.push(lines[p.l]);
      continue;
    }
    const words = lines[p.l].split(/\s+/).filter(Boolean);
    const total = pre[p.b] - pre[p.a];
    const cum: number[] = [];
    let c = 0;
    for (const w of words) cum.push((c += w.length + 1));
    let from0 = 0;
    for (let j = 0; j < k; j++) {
      if (j === k - 1) {
        out.push(words.slice(from0).join(" "));
        break;
      }
      const share = (pre[p.a + j + 1] - pre[p.a]) / total;
      let best = from0,
        bd = Infinity;
      for (let i = from0; i < words.length - (k - 1 - j); i++) {
        const dd = Math.abs(cum[i] / c - share);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
      out.push(words.slice(from0, best + 1).join(" "));
      from0 = best + 1;
    }
  }
  return { texts: out, cost: dp[L][R] / R };
}

/**
 * Il testo di una nota (righe separate da "\n") sulle righe di tratti trovate. Se Claude ha unito o diviso le
 * righe in modo diverso dalla carta, le parole si ridistribuiscono sulle righe vere in proporzione alla loro
 * larghezza, così ogni scritta resta dove l'hai scritta.
 */
export function splitIntoLines(text: string, strokes: Stroke[], fallback: Bounds): PlacedLabel[] {
  const lines = text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  if (!lines.length) return [];
  // la nota occupa il rettangolo dei suoi tratti: le righe sono a intervalli regolari (come si scrive un elenco);
  // ogni riga comincia dove cominciano i tratti in quella fascia (rientri e trattini restano al loro posto)
  // (senza i tratti isolati ai bordi: un pezzo di freccia o di disegno finito nel rettangolo non sposta la nota)
  let B = (strokes.length && strokeBounds(strokes)) || fallback;
  if (strokes.length >= 8) {
    const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
    const bs = strokes.map((s) => strokeBounds([s])!);
    const hs = bs.map((b) => b.maxY - b.minY).sort((a, b) => a - b);
    const half = q(hs, 0.5) / 2;
    const cy = bs.map((b) => (b.minY + b.maxY) / 2).sort((a, b) => a - b);
    const x0 = bs.map((b) => b.minX).sort((a, b) => a - b);
    const x1 = bs.map((b) => b.maxX).sort((a, b) => a - b);
    B = { minX: q(x0, 0.04), maxX: q(x1, 0.96), minY: q(cy, 0.04) - half * 1.6, maxY: q(cy, 0.96) + half * 1.6 };
  }
  const h = (B.maxY - B.minY) / lines.length;
  return lines.map((t, i) => {
    const top = B.minY + i * h,
      bottom = top + h;
    const inBand = strokes.filter((s) => {
      const c = center(s);
      return c.y >= top && c.y < bottom + (i === lines.length - 1 ? 0.01 : 0);
    });
    const bb = inBand.length ? strokeBounds(inBand)! : null;
    return { text: t, bounds: { minX: bb ? bb.minX : B.minX, maxX: bb ? bb.maxX : B.maxX, minY: top, maxY: bottom } };
  });
}

/** Due tratti si toccano (qualche punto a meno di `gap` unità). */
export function touches(a: Stroke, b: Stroke, gap: number): boolean {
  const g2 = gap * gap;
  for (let i = 0; i + 1 < a.pts.length; i += 3) {
    for (let j = 0; j + 1 < b.pts.length; j += 3) {
      const dx = a.pts[i] - b.pts[j],
        dy = a.pts[i + 1] - b.pts[j + 1];
      if (dx * dx + dy * dy <= g2) return true;
    }
  }
  return false;
}

/** Un tratto che va da vicino a una scritta a vicino al disegno (una freccia o una linea di richiamo). */
export function isConnector(s: Stroke, area: Bounds, labels: PlacedLabel[]): boolean {
  const n = Math.floor(s.pts.length / 3);
  const ends = [
    { x: s.pts[0], y: s.pts[1] },
    { x: s.pts[(n - 1) * 3], y: s.pts[(n - 1) * 3 + 1] },
  ];
  const nearArea = (p: { x: number; y: number }) => inside(p.x, p.y, grow(area, 3));
  const nearLabel = (p: { x: number; y: number }) => labels.some((l) => inside(p.x, p.y, grow(l.bounds, 3)));
  const b = strokeBounds([s])!;
  const small = b.maxX - b.minX < 4 && b.maxY - b.minY < 4; // punta della freccia
  return (nearArea(ends[0]) && nearLabel(ends[1])) || (nearArea(ends[1]) && nearLabel(ends[0])) || (small && (nearArea(ends[0]) || nearArea(ends[1])));
}

/** Una scritta accanto al disegno, in percentuale della tela: x/y = angolo in alto a sinistra, size = altezza (in % della larghezza). */
export interface LabelPos {
  x: number;
  y: number;
  size: number;
  text: string;
  /** Larghezza della scrittura a mano (in % della tela). */
  w?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** La tela del disegno in unità Ncode: origine e misura. */
export interface Canvas {
  ox: number;
  oy: number;
  W: number;
  H: number;
}

const S = 10;
const PAD = 1.5;

/** Grandezza (unità Ncode) e larghezza stimata del testo battuto di una scritta. */
function labelBox(l: PlacedLabel): { size: number; width: number; rect: Bounds } {
  const h = l.bounds.maxY - l.bounds.minY;
  const size = Math.max(1.3, Math.min(3.2, h * 0.85));
  // il testo battuto si stringe (quando lo si mostra) per non uscire dalla larghezza della scrittura
  const width = Math.max(l.bounds.maxX - l.bounds.minX, Math.min(l.text.length * size * 0.56, 4));
  return { size, width, rect: { minX: l.bounds.minX, minY: l.bounds.maxY - size, maxX: l.bounds.minX + width, maxY: l.bounds.maxY } };
}

/** Tela che contiene i tratti, le scritte e (se c'è) la tela di prima. */
export function canvasFor(strokes: Stroke[], labels: PlacedLabel[], prev?: Canvas): Canvas {
  let b = strokeBounds(strokes) ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  for (const l of labels) b = union(b, labelBox(l).rect);
  b = grow(b, PAD);
  if (prev) b = union(b, { minX: prev.ox, minY: prev.oy, maxX: prev.ox + prev.W, maxY: prev.oy + prev.H });
  return { ox: b.minX, oy: b.minY, W: b.maxX - b.minX, H: b.maxY - b.minY };
}

/** L'SVG del disegno su quella tela: solo i tratti, sfondo trasparente. */
export function drawingSvg(strokes: Stroke[], c: Canvas, opts: { maxForce?: number; ink?: string } = {}): string {
  const ink = opts.ink ?? "#1f2328";
  const maxForce = opts.maxForce ?? 1023;
  const paths = strokes
    .filter((s) => s.tip !== 1 && s.pts.length >= 3)
    .map((s) => `<path d="${strokePath(s.pts, c.ox, c.oy, S)}" stroke-width="${strokeWidth(s, maxForce, 0.22 * S).toFixed(2)}"/>`)
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(c.W * S).toFixed(1)} ${(c.H * S).toFixed(1)}" width="${(c.W * 2.371).toFixed(1)}mm" height="${(c.H * 2.371).toFixed(1)}mm">
<g fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">
${paths}
</g>
</svg>
`;
}

/** Dove va la scritta sulla tela (in %). */
export function anchorOf(l: PlacedLabel, c: Canvas): LabelPos {
  const { size } = labelBox(l);
  return {
    text: l.text,
    x: r1(((l.bounds.minX - c.ox) / c.W) * 100),
    y: r1(((l.bounds.maxY - 0.9 * size - c.oy) / c.H) * 100),
    size: r2((size / c.W) * 100),
    w: r1(((l.bounds.maxX - l.bounds.minX) / c.W) * 100),
  };
}

/** La stessa posizione di una scritta su una tela diversa (la tela si è allargata). */
export function moveAnchor(a: Anchor, from: Canvas, to: Canvas): Anchor {
  const x = from.ox + (a.x / 100) * from.W;
  const y = from.oy + (a.y / 100) * from.H;
  const size = (a.size / 100) * from.W;
  const w = a.w ? r1((((a.w / 100) * from.W) / to.W) * 100) : undefined;
  return { x: r1(((x - to.ox) / to.W) * 100), y: r1(((y - to.oy) / to.H) * 100), size: r2((size / to.W) * 100), ...(w ? { w } : {}) };
}

/**
 * Il disegno: un SVG con solo i tratti (sfondo trasparente) e la posizione delle scritte, che nella nota
 * restano testo vero (col tuo font, modificabile) sopra il disegno.
 */
export function drawingLayout(d: PlacedDrawing, opts: { maxForce?: number; ink?: string } = {}): { svg: string; labels: LabelPos[]; canvas: Canvas } {
  const canvas = canvasFor(d.strokes, d.labels);
  return { svg: drawingSvg(d.strokes, canvas, opts), labels: d.labels.map((l) => anchorOf(l, canvas)), canvas };
}

export const DRAWING_BLOCK = "neopen-disegno";

/** Il blocco che va nella nota: il file del disegno e una riga per scritta ("x y altezza testo", in %). */
/** Dove va una scritta sopra il disegno (in % della tela, come LabelPos): il testo è la riga della nota. */
export interface Anchor {
  x: number;
  y: number;
  size: number;
  /** Larghezza della scrittura a mano (in % della tela): il testo battuto non la supera. */
  w?: number;
}

export function formatDrawingBlock(file: string, labels: LabelPos[], beside?: Beside, anchors?: Anchor[]): string {
  const head = [`file: ${file}`];
  // "scritte: 44.1,13.2,3.6 69.9,27.9,4.75" = le prime righe dopo il disegno sono le sue scritte: vanno mostrate
  // sopra il disegno in quel punto e con quella grandezza (x, y, altezza in % della tela)
  if (anchors?.length) head.push(`scritte: ${anchors.map((a) => `${r1(a.x)},${r1(a.y)},${r2(a.size)}${a.w ? `,${r1(a.w)}` : ""}`).join(" ")}`);
  // "accanto: destra 5" = le 5 righe dopo il disegno vanno alla sua destra, come sulla carta
  if (beside) head.push(`accanto: ${beside.side === "right" ? "destra" : "sinistra"} ${beside.lines}`);
  // "grandezze: 0.75 1" = la prima riga accanto più piccola del testo normale, la seconda normale
  const sizes = beside?.sizes ?? [];
  if (sizes.some((s) => s !== 1)) head.push(`grandezze: ${sizes.map((s) => r2(s)).join(" ")}`);
  const rows = labels.filter((l) => l.text.trim()).map((l) => `${r1(l.x)} ${r1(l.y)} ${r2(l.size)} ${l.text.replace(/\s+/g, " ").trim()}`);
  return ["```" + DRAWING_BLOCK, ...head, ...rows, "```"].join("\n");
}

export function parseDrawingBlock(src: string): { file: string; labels: LabelPos[]; beside?: Beside; anchors: Anchor[] } {
  let file = "";
  const anchors: Anchor[] = [];
  let beside: Beside | undefined;
  let pendingSizes: number[] | undefined;
  const labels: LabelPos[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    const b = /^accanto:\s*(destra|sinistra|right|left)\s+(\d+)/i.exec(line);
    if (b) {
      const n = Number(b[2]);
      if (n > 0) beside = { side: /^(destra|right)$/i.test(b[1]) ? "right" : "left", lines: n, sizes: beside?.sizes };
      continue;
    }
    const sc = /^scritte:\s*(.*)$/i.exec(line);
    if (sc) {
      for (const t of sc[1].trim().split(/\s+/)) {
        const v = t.split(",").map(Number);
        if ((v.length === 3 || v.length === 4) && v.every((x) => Number.isFinite(x))) anchors.push({ x: v[0], y: v[1], size: v[2], ...(v[3] ? { w: v[3] } : {}) });
      }
      continue;
    }
    const g = /^grandezze:\s*(.+)$/i.exec(line);
    if (g) {
      const sizes = g[1].split(/[\s;]+/).map((v) => Number(v.replace(",", "."))).filter((v) => v > 0 && v < 5);
      if (beside) beside.sizes = sizes;
      else pendingSizes = sizes;
      continue;
    }
    const f = /^file:\s*(.+)$/i.exec(line);
    if (f) {
      file = f[1].trim().replace(/^!?\[\[|\]\]$/g, "");
      continue;
    }
    const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (m) labels.push({ x: Number(m[1]), y: Number(m[2]), size: Number(m[3]), text: m[4] });
  }
  if (beside && !beside.sizes && pendingSizes) beside.sizes = pendingSizes;
  return { file, labels, beside, anchors };
}

/** Sostituisce nel testo della nota il blocco del disegno `file` (se c'è). */
export function replaceDrawingBlock(content: string, file: string, block: string): string {
  const re = new RegExp("```" + DRAWING_BLOCK + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```", "g");
  return content.replace(re, (all, body: string) => (parseDrawingBlock(body).file === file ? block : all));
}

const unesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * Disegni fatti con la v0.14.0 (scritte dentro l'SVG, sfondo bianco): l'SVG con solo i tratti e le scritte a parte.
 * null se l'SVG non è di quel tipo.
 */
export function splitLegacyDrawing(svg: string): { svg: string; labels: LabelPos[] } | null {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return null;
  const w = Number(vb[1]),
    h = Number(vb[2]);
  const labels: LabelPos[] = [];
  for (const m of svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" font-size="([\d.]+)">([^<]*)<\/text>/g)) {
    const x = Number(m[1]),
      y = Number(m[2]),
      fs = Number(m[3]);
    labels.push({ text: unesc(m[4]), x: r1((x / w) * 100), y: r1(((y - 0.78 * fs) / h) * 100), size: r2((fs / w) * 100) });
  }
  const clean = svg
    .replace(/<rect[^>]*\/>\n?/g, "")
    .replace(/<g fill="[^"]*" font-family[\s\S]*?<\/g>\n?/g, "");
  return { svg: clean, labels };
}

/** #tag scritti nelle scritte dei disegni (senza #, minuscoli). */
export function labelTags(d: { labels: PlacedLabel[] }): string[] {
  return d.labels.flatMap((l) => [...l.text.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_\-/]*)/gu)].map((m) => m[1].toLowerCase()));
}

/** Grandezza di una scritta rispetto alla scrittura normale (circa 2,4 unità Ncode, ~5,5 mm con le aste). */
export function labelEm(h: number): number {
  const em = Math.max(0.7, Math.min(1.8, h / 2.4));
  return Math.round(em * 20) / 20;
}

/**
 * Disegni con le scritte dentro il blocco (v0.14.1–0.14.4): le scritte diventano righe della nota subito dopo il
 * blocco, mostrate sopra il disegno nello stesso punto.
 */
export function labelsToLines(file: string, labels: LabelPos[]): string | null {
  if (!labels.length) return null;
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  const block = formatDrawingBlock(file, [], undefined, sorted);
  return `${block}\n${sorted.map((l) => escapeLabelLine(l.text)).join("\n")}\n`;
}

/**
 * Nel testo della nota: il blocco del disegno `file` e le righe (non vuote) che lo seguono, fino a `count`.
 * Indici delle righe di `content.split("\n")`. null se il blocco non c'è.
 */
export function linesAfterBlock(content: string, file: string, count: number): { open: number; close: number; after: number[] } | null {
  const lines = content.split("\n");
  const open = "```" + DRAWING_BLOCK;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(open)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].replace(/\r$/, "").trim() !== "```") j++;
    if (j >= lines.length) return null;
    if (parseDrawingBlock(lines.slice(i + 1, j).join("\n")).file !== file) {
      i = j;
      continue;
    }
    const after: number[] = [];
    for (let k = j + 1; k < lines.length && after.length < count; k++) {
      const t = lines[k].replace(/\r$/, "").trim();
      if (!t) continue;
      if (t.startsWith("<!--") || t.startsWith("```")) break;
      after.push(k);
    }
    return { open: i, close: j, after };
  }
  return null;
}

/**
 * Una scritta del disegno è una riga della nota: "- boxy" o "1. pixel" diventerebbero un elenco, "# titolo" un
 * titolo. Si scrivono con "\\" davanti (nella nota restano testo semplice); sopra il disegno si mostrano senza.
 */
export function escapeLabelLine(text: string): string {
  return /^\s*([-*+]|\d+[.)]|#{1,6}|>)(\s|$)/.test(text) ? `\\${text.trimStart()}` : text;
}

export function unescapeLabelLine(line: string): string {
  return line.replace(/^\\(?=([-*+]|\d+[.)]|#{1,6}|>)(\s|$))/, "");
}

/** Una nota scritta in fondo a una freccia che parte dal disegno, che Claude non ha dato come scritta. */
interface OrphanNote {
  strokes: Stroke[];
  arrow: Stroke[];
  bounds: Bounds;
  rows: Bounds[];
  widths: number[];
}

const gapBetween = (a: Bounds, b: Bounds): { x: number; y: number } => ({
  x: Math.max(0, a.minX - b.maxX, b.minX - a.maxX),
  y: Math.max(0, a.minY - b.maxY, b.minY - a.maxY),
});

/**
 * Note attaccate al disegno da una freccia che Claude ha lasciato nel testo (non fra le scritte): la freccia parte
 * a ridosso del disegno e finisce vicino a un gruppo di righe di scrittura. Si cercano dai tratti.
 */
export function findOrphanNotes(drawing: Stroke[], used: Set<Stroke>, candidates: Stroke[]): OrphanNote[] {
  const db = strokeBounds(drawing);
  if (!db) return [];
  const dpts: number[] = [];
  for (const d of drawing) for (let i = 0; i + 1 < d.pts.length; i += 3) dpts.push(d.pts[i], d.pts[i + 1]);
  const dist = (x: number, y: number) => {
    let m = Infinity;
    for (let i = 0; i < dpts.length; i += 2) {
      const d = (dpts[i] - x) ** 2 + (dpts[i + 1] - y) ** 2;
      if (d < m) m = d;
    }
    return Math.sqrt(m);
  };
  const free = candidates.filter((s) => !used.has(s) && s.pts.length >= 6);
  const bb = new Map<Stroke, Bounds>();
  const B = (s: Stroke) => bb.get(s) ?? (bb.set(s, strokeBounds([s])!), bb.get(s)!);
  const ext = (s: Stroke) => Math.max(B(s).maxX - B(s).minX, B(s).maxY - B(s).minY);
  const ends = (s: Stroke) => {
    const n = Math.floor(s.pts.length / 3);
    return [
      { x: s.pts[0], y: s.pts[1] },
      { x: s.pts[(n - 1) * 3], y: s.pts[(n - 1) * 3 + 1] },
    ];
  };
  const near = (a: Stroke, b: Stroke) => {
    const p = B(a),
      q = B(b);
    const g = gapBetween(p, q);
    return g.x <= 0.8 && g.y <= 0.8 && touches(a, b, 0.8);
  };
  // le frecce: (1) fuori dal disegno: un tratto a ridosso del disegno (la punta) e il tratto lungo che gli si attacca;
  // (2) già nel disegno: un tratto lungo con un capo libero (non tocca altri tratti del disegno) vicino a scrittura
  const arrows: { arrow: Set<Stroke>; far: { x: number; y: number } }[] = [];
  const heads = free.filter((s) => ends(s).some((e) => dist(e.x, e.y) <= 2.5) && ext(s) >= 0.6);
  const seen = new Set<Stroke>();
  for (const h of heads) {
    if (seen.has(h)) continue;
    const arrow = new Set<Stroke>([h]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of free) if (!arrow.has(s) && ext(s) >= 3.5 && [...arrow].some((a) => near(s, a))) (arrow.add(s), (grew = true));
    }
    for (const a of arrow) seen.add(a);
    let far: { x: number; y: number } | null = null;
    let fd = 0;
    for (const a of arrow)
      for (const e of ends(a)) {
        const d = dist(e.x, e.y);
        if (d > fd) (fd = d), (far = e);
      }
    if (far && fd >= 3.5) arrows.push({ arrow, far });
  }
  const lonely = (s: Stroke, e: { x: number; y: number }) => {
    for (const d of drawing) {
      if (d === s) continue;
      for (let i = 0; i + 1 < d.pts.length; i += 3) if ((d.pts[i] - e.x) ** 2 + (d.pts[i + 1] - e.y) ** 2 < 0.8 * 0.8) return false;
    }
    return true;
  };
  const touchesFree = (e: { x: number; y: number }) =>
    free.some((f) => {
      for (let i = 0; i + 1 < f.pts.length; i += 3) if ((f.pts[i] - e.x) ** 2 + (f.pts[i + 1] - e.y) ** 2 < 1.2 * 1.2) return true;
      return false;
    });
  for (const s of drawing) {
    if (ext(s) < 3) continue;
    for (const e of ends(s)) if (lonely(s, e) && touchesFree(e)) arrows.push({ arrow: new Set([s]), far: e });
  }
  const out: OrphanNote[] = [];
  const taken = new Set<Stroke>();
  for (const { arrow, far } of arrows) {
    // la nota: i tratti vicino alla fine della freccia e, a catena, le righe che li seguono
    const isArrow = (s: Stroke) => arrow.has(s) || taken.has(s);
    const members: Stroke[] = [];
    for (const s of free) {
      if (isArrow(s) || drawing.includes(s)) continue;
      const g = gapBetween(B(s), { minX: far.x, maxX: far.x, minY: far.y, maxY: far.y });
      if (g.x <= 2.2 && g.y <= 2.2) members.push(s);
    }
    if (!members.length) continue;
    const mset = new Set(members);
    for (let grew = true; grew && members.length < 220; ) {
      grew = false;
      for (const s of free) {
        if (mset.has(s) || isArrow(s)) continue;
        // (un tratto del disegno vero e proprio non è mai della nota)
        if (members.some((m) => {
          const g = gapBetween(B(s), B(m));
          return g.x <= 3.2 && g.y <= 1.2;
        })) {
          mset.add(s);
          members.push(s);
          grew = true;
        }
      }
    }
    // pezzi della nota che erano finiti nel disegno: tratti piccoli staccati dal resto del disegno (una parola
    // della nota a ridosso del disegno), vicini alle righe della nota
    for (let grew = true, n = 0; grew && n < 6; n++) {
      grew = false;
      for (const s of drawing) {
        if (mset.has(s) || arrow.has(s) || taken.has(s) || ext(s) > 4) continue;
        if (!members.some((m) => {
          const g = gapBetween(B(s), B(m));
          return g.x <= 3.2 && g.y <= 1.2;
        })) continue;
        const attached = drawing.some((d) => d !== s && !mset.has(d) && !arrow.has(d) && (() => {
          const g = gapBetween(B(s), B(d));
          return g.x <= 0.4 && g.y <= 0.4 && touches(s, d, 0.4);
        })());
        if (attached) continue;
        mset.add(s);
        members.push(s);
        grew = true;
      }
    }
    if (members.length < 3 || members.length >= 220) continue;
    const arr = [...arrow];
    for (const a of arr) taken.add(a);
    for (const m of members) taken.add(m);
    const bounds = strokeBounds(members)!;
    const bands = rowBands(members);
    if (!bands.length || bands.length > 9) continue;
    const rows = bands.map((bd) => {
      const m = members.filter((s) => {
        const c = center(s);
        return c.y >= bd.minY && c.y <= bd.maxY;
      });
      return m.length ? strokeBounds(m)! : bounds;
    });
    out.push({ strokes: members, arrow: arr, bounds, rows, widths: rows.map((r) => Math.max(0.5, r.maxX - r.minX)) });
  }
  return out;
}

/**
 * Note che Claude non ha riconosciuto come scritte del disegno (ma che sulla carta sono in fondo a una freccia che
 * parte da lì): si aggiungono alle scritte del disegno, col testo che Claude ha scritto nelle righe dopo il disegno.
 * Restituisce quante note ha aggiunto.
 */
export function addOrphanLabels(
  specs: { box: number[]; labels: { text: string; box: number[]; arrow?: number[]; line_boxes?: number[][] }[] }[],
  placed: PlacedDrawing[],
  png: Pick<PngResult, "ox" | "oy" | "scale">,
  candidates: Stroke[],
  linesAfter: (index: number) => string[]
): number {
  let added = 0;
  const px = (b: Bounds) => [(b.minX - png.ox) * png.scale, (b.minY - png.oy) * png.scale, (b.maxX - png.ox) * png.scale, (b.maxY - png.oy) * png.scale];
  const used = new Set<Stroke>();
  for (const d of placed) for (const s of [...d.strokes, ...(d.labelStrokes ?? [])]) used.add(s);
  for (const d of placed) {
    const notes = findOrphanNotes(d.strokes, used, candidates);
    if (!notes.length) continue;
    // (le righe che ripetono una scritta già trovata non sono della nota)
    const have = new Set(d.labels.map((l) => normText(l.text)));
    const avail = linesAfter(d.index).filter((t) => t.trim() && !have.has(normText(t)));
    if (!avail.length) continue;
    // ordine di lettura: prova tutti gli ordini delle note (al massimo 4) e tiene quello in cui il testo si adatta meglio
    const orders: number[][] = [];
    const permute = (rest: number[], cur: number[]) => {
      if (!rest.length) return void orders.push(cur);
      for (const r of rest) permute(rest.filter((x) => x !== r), [...cur, r]);
    };
    permute(notes.slice(0, 4).map((_, i) => i), []);
    let best: { order: number[]; texts: string[]; cost: number } | null = null;
    for (const order of orders) {
      const widths = order.flatMap((i) => notes[i].widths);
      const groups = order.flatMap((i, g) => notes[i].widths.map(() => g));
      for (let m = Math.min(avail.length, widths.length); m >= Math.max(order.length, Math.ceil(widths.length / 2)); m--) {
        const r = assignRows(avail.slice(0, m), widths, groups);
        // si prende più righe del testo possibile quando il costo è simile: ogni riga ha il suo posto
        if (r && r.cost < 0.55 && (!best || r.cost < best.cost - 0.02)) best = { order, texts: r.texts, cost: r.cost };
      }
    }
    if (!best) continue;
    let k = 0;
    for (const i of best.order) {
      const n = notes[i];
      const texts = best.texts.slice(k, k + n.rows.length);
      k += n.rows.length;
      if (texts.length !== n.rows.length) continue;
      let ab = strokeBounds(n.arrow)!;
      ab = grow(ab, 0);
      specs[d.index].labels.push({ text: texts.join("\n"), box: px(n.bounds), line_boxes: n.rows.map(px), arrow: px(ab) });
      added++;
    }
  }
  return added;
}

/** Testo senza trattini, # e spazi, per confrontare una riga con una scritta. */
export const normText = (t: string): string => t.toLowerCase().replace(/^[\s\\\-–•*]+/, "").replace(/[#\s.:,;]+/g, "");
