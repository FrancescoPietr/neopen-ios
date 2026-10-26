// Lo schema delle pagine campione dipende dalla lingua di chi scrive: le due frasi di riferimento (testo noto,
// che Claude confronta lettera per lettera), le lettere accentate e i gruppi di lettere tipici.
// Ogni coppia di frasi è controllata: la prima contiene tutte le lettere dell'alfabeto, la seconda le coppie che
// si confondono nella scrittura a mano (rn/m, cl/d, ol, ri, ci, un/nu, lt, ll, tt…) e gli accenti della lingua.

export type SampleLang = "it" | "en" | "es" | "fr" | "de" | "pt";

export const SAMPLE_LANGS: Record<SampleLang, { name: string; accents: string; pairs: string; sentences: [string, string] }> = {
  it: { name: "Italiano", accents: "à è é ì ò ù", pairs: "sc gn gl ch gh qu zz", sentences: ["Quel vituperabile xenofobo zelante assaggia il whisky ed esclama: alleluja!", "Così, già al mattino, la mamma e la nonna di Gigi riempiono la pizza di olio d'oliva: è un giorno nuvoloso, il clima è chiuso e tutto il cielo sembra più alto perché c'è un ghiro che sognò l'aglio squisito."] },
  en: { name: "English", accents: "' - (apostrofi e trattini)", pairs: "th sh ch ck wh ph qu", sentences: ["The quick brown fox jumps over the lazy dog.", "On a summer morning, Anne and her grandmother bring three precious chocolate cookies to Phil, who sits on the old cliff, shuts his eyes, counts the small clouds and feels quietly happy watching a little nuthatch on the salty hill."] },
  es: { name: "Español", accents: "á é í ó ú ü ñ ¿ ¡", pairs: "ll rr ch qu gu", sentences: ["El veloz murciélago hindú comía feliz cardillo y kiwi. La cigüeña tocaba el saxofón detrás del palenque de paja.", "Mañana temprano, la abuela llevará churros y queso a la orilla del río, mientras Guillermo corre tras un perro pequeño y Ángel canta una canción perenne: el clima de invierno es nublado, alto y olvidado."] },
  fr: { name: "Français", accents: "à â é è ê ë î ï ô ù û ç œ", pairs: "ou qu gn ch", sentences: ["Portez ce vieux whisky au juge blond qui fume.", "À l'aube, Noël et Zoé ont goûté une crème brûlée près du château ; le garçon de l'hôtel, sur l'île, ouvre la fenêtre, mange du maïs et regarde où vont les nuages multicolores dans le ciel : l'été semble déjà plus chaud, comme le climat de la montagne, et Anne attend toute la journée à l'école en riant, tranquille."] },
  de: { name: "Deutsch", accents: "ä ö ü ß", pairs: "sch ck ei ie", sentences: ["Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich.", "Morgens schwimmen Jürgen und Anna schnell zur Brücke, während ihr kluger Hund Rex lächelnd auf der Wiese sitzt, gern die Vögel zählt und von Wolken, Rindern, Nudeln und einem Clown träumt."] },
  pt: { name: "Português", accents: "á â ã à ç é ê í ó ô õ ú", pairs: "lh nh rr ss", sentences: ["Zebras caolhas de Java querem passar fax para moças gigantes de New York.", "À noite, João e a avó comeram pão quente com manteiga; o cachorro corria atrás da galinha no quintal, enquanto o coração da menina da cidade ficou cheio de lições e emoções. Você e o avô viram o clima úmido, a nuvem alta e a âncora no inverno: é difícil, mas é o mundo."] },
};

/** La lingua scelta, o (con "auto") quella di Obsidian; se non c'è fra quelle previste, l'inglese. */
export function resolveLang(setting: string | undefined): SampleLang {
  const pick = (v: string | null | undefined): SampleLang | null => {
    const k = String(v ?? "").slice(0, 2).toLowerCase();
    return k in SAMPLE_LANGS ? (k as SampleLang) : null;
  };
  if (setting && setting !== "auto") return pick(setting) ?? "en";
  let ui: string | null = null;
  try {
    ui = window.localStorage.getItem("language");
  } catch {
    ui = null;
  }
  return pick(ui) ?? pick(typeof navigator !== "undefined" ? navigator.language : "") ?? "en";
}

/** Lo schema spiegato a Claude (in inglese), con le frasi della lingua di chi scrive. */
export function alphabetScheme(lang: SampleLang): string {
  const L = SAMPLE_LANGS[lang];
  return `Each sample page starts with a tag like "#alfabeto". The author writes in their usual everyday handwriting, which may mix print and cursive. Every item is written SEVERAL times, in different ways (careful and fast, at the start, middle and end of a word), so several shapes can mean the same letter.
1. PRINT capitals: A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
2. PRINT small letters: a b c d e f g h i j k l m n o p q r s t u v w x y z
3. CURSIVE capitals: A B C … Z
4. CURSIVE small letters, one by one: a b c … z
5. Letter pairs that look alike: ol d · cl d · rn m · nn m · un nu · ii u · a o e c · lt ll tt · ri n · ci a · ${L.pairs}
6. Digits: 0 1 2 3 4 5 6 7 8 9 · and look-alikes: 1 l I · 0 O o · 5 S · 2 z Z · 9 g q
7. Accents and symbols: ${L.accents} · # @ & % € + - = → ← ( ) : ; , . ! ? " ' /
8. Frequent words (one per line, several times).
9. The two REFERENCE SENTENCES (${L.name}), always exactly this text, written in the author's normal handwriting at normal speed. The text is known: line it up letter by letter with the writing to learn how the author writes each letter and each pair of letters:
   «${L.sentences[0]}»
   «${L.sentences[1]}»`;
}
