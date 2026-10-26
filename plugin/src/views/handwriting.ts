// La tua calligrafia: lo schema da scrivere (pagine che iniziano con #alfabeto) e i campioni che Claude guarda
// a ogni trascrizione. Vale per chiunque usi il plugin: ognuno scrive le sue pagine.

import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import { SAMPLE_LANGS, SampleLang } from "../transcribe/samples";

/** Lo schema, per chi scrive (in italiano), con accenti, gruppi di lettere e frasi della lingua scelta. */
export function schemeSections(lang: SampleLang): { title: string; items: string[] }[] {
  const L = SAMPLE_LANGS[lang];
  return [
    { title: "Stampatello maiuscolo", items: ["A B C D E F G H I J K L M N O P Q R S T U V W X Y Z"] },
    { title: "Stampatello minuscolo", items: ["a b c d e f g h i j k l m n o p q r s t u v w x y z"] },
    { title: "Corsivo maiuscolo (se lo usi)", items: ["A B C D E F G H I J K L M N O P Q R S T U V W X Y Z"] },
    { title: "Corsivo minuscolo (se lo usi)", items: ["a b c d e f g h i j k l m n o p q r s t u v w x y z", "anche legate a coppie: ab bc cd de ef fg gh …"] },
    { title: "Lettere che si confondono", items: ["ol / d · cl / d · rn / m · nn / m · un / nu · ii / u", `a o e c · lt ll tt · ri / n · ci / a · ${L.pairs}`] },
    { title: "Numeri e simili", items: ["0 1 2 3 4 5 6 7 8 9", "1 l I · 0 O o · 5 S · 2 z Z · 9 g q"] },
    { title: "Accenti e simboli", items: [L.accents, "# @ & % € + − = → ← ( ) : ; , . ! ? « » /"] },
    { title: "Parole frequenti", items: ["le parole che scrivi più spesso: nomi, progetti, sigle (anche quelle in Impostazioni → Parole frequenti)"] },
    {
      title: `Le due frasi di riferimento (${L.name})`,
      items: [
        "Copiale esattamente, scrivendo come fai di solito, alla tua velocità normale: in corsivo, in stampatello o mischiato, come ti viene. Claude conosce già il testo e lo confronta lettera per lettera con la tua scrittura.",
        `«${L.sentences[0]}»`,
        `«${L.sentences[1]}»`,
      ],
    },
  ];
}

const HOW = [
  "Comincia ogni pagina scrivendo #alfabeto in alto: quella pagina non diventa una nota, ma un esempio della tua scrittura.",
  "Scrivi come fai di solito. Ripeti ogni cosa più volte e in modi diversi: con calma e di fretta, all'inizio, in mezzo e alla fine di una parola. Più varianti ci sono, meglio Claude riconosce le tue lettere.",
  "Puoi dividere lo schema su più pagine (quante usarne lo scegli nelle impostazioni, di base 4) e rifare una pagina quando vuoi migliorarla.",
];

export function schemeMarkdown(lang: SampleLang): string {
  const parts = ["# Schema per la calligrafia", "", ...HOW.map((h) => `- ${h}`), ""];
  schemeSections(lang).forEach((s, i) => {
    parts.push(`## ${i + 1}. ${s.title}`, ...s.items.map((it) => `- ${it}`), "");
  });
  return parts.join("\n");
}

/** Finestra con lo schema: da tenere accanto mentre scrivi (o da salvare come nota e stampare). */
export class SchemeModal extends Modal {
  constructor(app: App, private notePath: string, private lang: SampleLang) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("neopen-scheme");
    this.setTitle("Schema per la tua calligrafia");
    const how = contentEl.createEl("ul", { cls: "neopen-scheme-how" });
    for (const h of HOW) how.createEl("li", { text: h });
    const ol = contentEl.createEl("ol", { cls: "neopen-scheme-list" });
    for (const s of schemeSections(this.lang)) {
      const li = ol.createEl("li");
      li.createEl("strong", { text: s.title });
      for (const it of s.items) li.createDiv({ cls: "neopen-scheme-item", text: it });
    }
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Copia").onClick(async () => {
          await navigator.clipboard.writeText(schemeMarkdown(this.lang));
          new Notice("Schema copiato.");
        })
      )
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Salva come nota")
          .onClick(async () => {
            const path = normalizePath(this.notePath);
            const f = this.app.vault.getAbstractFileByPath(path);
            const file = f instanceof TFile ? f : await this.app.vault.create(path, schemeMarkdown(this.lang));
            await this.app.workspace.getLeaf(true).openFile(file);
            this.close();
          })
      );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** Pagina del quaderno (immagine SVG del plugin) → PNG per Claude, circa `pixels` pixel in tutto, sfondo bianco. */
export async function svgToPngBase64(svgText: string, pixels: number): Promise<string | null> {
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svgText);
  if (!vb) return null;
  const w = Number(vb[3]),
    h = Number(vb[4]);
  const k = Math.sqrt(pixels / (w * h));
  const W = Math.max(1, Math.round(w * k)),
    H = Math.max(1, Math.round(h * k));
  // l'inchiostro sempre nero pieno, su bianco
  const clean = svgText
    .replace(/width="[^"]*"/, `width="${W}"`)
    .replace(/height="[^"]*"/, `height="${H}"`)
    .replace(/stroke="#[0-9a-fA-F]{3,6}"/g, 'stroke="#000000"');
  const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((ok, ko) => {
      img.onload = () => ok();
      img.onerror = () => ko(new Error("immagine non valida"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    return canvas.toDataURL("image/png").split(",")[1];
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "3_27_746_11" → "quaderno 746, pagina 11". */
export const pageLabel = (id: string): string => {
  const p = id.split("_");
  return p.length >= 4 ? `quaderno ${p[2]}, pagina ${p[3]}` : id;
};
