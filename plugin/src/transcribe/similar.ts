// Is this the same task written again? Claude reads cursive slightly differently each time ("andare alla gentita" /
// "andare alla gelateria"), so titles are compared loosely: no case, accents, punctuation, #tags; small typos allowed.

export function looseTitle(t: string): string {
  return (t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(?:^|\s)#[\p{L}\p{N}_\-/]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a: string, b: string) => 1 - distance(a, b) / Math.max(a.length, b.length);

/** True when two task titles are (almost) the same: every word matches (two words in three for long titles). */
export function sameTitle(x: string, y: string): boolean {
  const a = looseTitle(x);
  const b = looseTitle(y);
  if (!a || !b) return false;
  if (a === b) return true;
  // one contains the other ("completare app" / "completare app neopen")
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return true;
  const wa = a.split(" ").filter((w) => w.length >= 3);
  const wb = b.split(" ").filter((w) => w.length >= 3);
  if (!wa.length || !wb.length) return false;
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const matched = few.filter((w) => many.some((v) => w === v || (Math.min(w.length, v.length) >= 4 && ratio(w, v) >= 0.75))).length;
  const n = many.length;
  return n >= 3 ? matched / n >= 0.66 : matched === n;
}
