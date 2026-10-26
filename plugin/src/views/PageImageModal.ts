// Disegno della pagina a schermo intero: si apre cliccando la miniatura nella nota.
// Si apre "adattato" (tutta la pagina visibile). Clic su un punto = ingrandisci lì; clic di nuovo = torna intera.
// Rotellina (o pizzico sul trackpad) = zoom continuo; trascina per spostarti.

import { App, Modal } from "obsidian";

export class PageImageModal extends Modal {
  private scale = 1;
  private fit = 1;

  constructor(app: App, private src: string) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("neopen-image-modal");
    const wrap = this.contentEl.createDiv("neopen-image-wrap");
    const img = wrap.createEl("img", { attr: { src: this.src, draggable: "false" } });

    const apply = (cx?: number, cy?: number) => {
      // punto dell'immagine sotto il cursore, da tenere fermo durante lo zoom
      const r = img.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const px = cx !== undefined ? (cx - r.left) / r.width : 0.5;
      const py = cy !== undefined ? (cy - r.top) / r.height : 0;
      const w = img.naturalWidth * this.fit * this.scale;
      img.style.width = `${w}px`;
      img.style.height = "auto";
      wrap.toggleClass("is-zoomed", this.scale > 1.01);
      const nr = img.getBoundingClientRect();
      wrap.scrollLeft = px * nr.width - (cx !== undefined ? cx - wr.left : wr.width / 2);
      wrap.scrollTop = py * nr.height - (cy !== undefined ? cy - wr.top : 0);
    };

    const computeFit = () => {
      const wr = wrap.getBoundingClientRect();
      const nw = img.naturalWidth || 1;
      const nh = img.naturalHeight || 1;
      // tutta la pagina visibile, senza superare le dimensioni del riquadro
      this.fit = Math.min((wr.width - 8) / nw, (wr.height - 8) / nh);
      this.scale = 1;
      apply();
    };
    if (img.complete && img.naturalWidth) window.setTimeout(computeFit, 0);
    else img.onload = computeFit;

    // clic (senza trascinare) = ingrandisci in quel punto / torna alla pagina intera
    let start: { x: number; y: number; sl: number; st: number; moved: boolean } | null = null;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false };
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
      if (start.moved && this.scale > 1.01) {
        wrap.scrollLeft = start.sl - dx;
        wrap.scrollTop = start.st - dy;
      }
    });
    wrap.addEventListener("pointerup", (e) => {
      const s0 = start;
      start = null;
      if (!s0 || s0.moved) return;
      // clic fuori dall'immagine (sul bordo scuro) quando non è ingrandita: chiudi
      const r = img.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside && this.scale <= 1.01) {
        this.close();
        return;
      }
      this.scale = this.scale > 1.01 ? 1 : 3;
      apply(e.clientX, e.clientY);
    });
    wrap.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
        this.scale = Math.min(8, Math.max(1, this.scale * factor));
        apply(e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
