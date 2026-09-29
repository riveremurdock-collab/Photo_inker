// Preview area: WebGL canvas, zoom/pan/pinch, fit-to-screen, and a small zoom
// toolbar. Zoom math is adapted from the stipple tool's preview (zoom keeps
// the point under the cursor fixed; pan uses pointer capture), rewritten for
// a viewport-sized WebGL canvas and devicePixelRatio.

import { ViewRenderer, type ViewTransform } from "./viewRenderer";

const MAX_SCALE = 32; // 3200%
const FIT_PADDING_CSS = 24;

/** While set, a click (without dragging) on the image picks instead of panning. */
export interface PickHandler {
  onHover(clientX: number, clientY: number): void;
  onPick(clientX: number, clientY: number): void;
  onLeave(): void;
}

/** Pointer travel (CSS px) below which a press counts as a click, not a drag. */
const CLICK_SLOP = 4;

export interface PreviewOptions {
  /** Background color around the image, linear RGB. */
  background: [number, number, number];
  onFilesDropped: (files: FileList) => void;
  onViewChange?: (scale: number) => void;
}

export class Preview {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: ViewRenderer;
  private emptyState: HTMLElement;
  private zoomLabel: HTMLButtonElement;

  private imageWidth = 0;
  private imageHeight = 0;
  private view: ViewTransform = { scale: 1, originX: 0, originY: 0 };
  /** While true, resizing the window refits the image. Cleared by any manual zoom or pan. */
  private fitted = true;
  private frameRequested = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pickHandler: PickHandler | null = null;
  private pressStart: { x: number; y: number; moved: boolean } | null = null;
  private gesture: { scale: number; originX: number; originY: number; midX: number; midY: number; dist: number } | null =
    null;

  constructor(private options: PreviewOptions) {
    this.element = document.createElement("section");
    this.element.className = "preview";
    this.element.setAttribute("aria-label", "Preview");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "preview-canvas";
    this.element.append(this.canvas);
    this.renderer = new ViewRenderer(this.canvas, options.background);

    this.emptyState = document.createElement("div");
    this.emptyState.className = "preview-empty";
    this.emptyState.innerHTML = `<p><strong>Drop an image here</strong><br />or use Upload in the panel.</p><p class="hint">JPG, PNG, or WebP</p>`;
    this.element.append(this.emptyState);

    const toolbar = document.createElement("div");
    toolbar.className = "preview-toolbar";
    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      toolbar.append(b);
      return b;
    };
    button("−", "Zoom out (−)", () => this.zoomBy(1 / Math.SQRT2));
    this.zoomLabel = button("100%", "Actual pixels (1)", () => this.zoomTo(1));
    this.zoomLabel.classList.add("zoom-label");
    button("+", "Zoom in (+)", () => this.zoomBy(Math.SQRT2));
    button("Fit", "Fit to screen (0)", () => this.fit());
    this.element.append(toolbar);
    toolbar.hidden = true;

    this.bindInteractions();
    this.bindDrop();
    new ResizeObserver(() => this.resize()).observe(this.element);
  }

  setPaper(linear: [number, number, number]): void {
    this.renderer.setPaper(linear);
    this.requestRender();
  }

  /** Turns eyedropper picking on (handler) or off (null). */
  setPickHandler(handler: PickHandler | null): void {
    this.pickHandler?.onLeave();
    this.pickHandler = handler;
    this.canvas.classList.toggle("picking", handler !== null);
  }

  get hasImage(): boolean {
    return this.imageWidth > 0;
  }

  setImage(bitmap: ImageBitmap): void {
    this.renderer.setImage(bitmap);
    this.imageWidth = bitmap.width;
    this.imageHeight = bitmap.height;
    this.emptyState.hidden = true;
    this.element.querySelector<HTMLElement>(".preview-toolbar")!.hidden = false;
    this.element.classList.add("has-image");
    this.fit();
  }

  /** Maps a mouse position to image pixel coordinates (may fall outside the image). */
  clientToImage(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    return {
      x: ((clientX - rect.left) * dpr - this.view.originX) / this.view.scale,
      y: ((clientY - rect.top) * dpr - this.view.originY) / this.view.scale,
    };
  }

  fit(): void {
    if (!this.hasImage) return;
    const pad = FIT_PADDING_CSS * this.dpr();
    const w = Math.max(1, this.canvas.width - pad * 2);
    const h = Math.max(1, this.canvas.height - pad * 2);
    const scale = Math.min(w / this.imageWidth, h / this.imageHeight);
    this.view = {
      scale,
      originX: (this.canvas.width - this.imageWidth * scale) / 2,
      originY: (this.canvas.height - this.imageHeight * scale) / 2,
    };
    this.fitted = true;
    this.changed();
  }

  /** Zooms to an absolute scale (1 = 100%) around the view center. */
  zoomTo(scale: number): void {
    this.zoomAround(scale, this.canvas.width / 2, this.canvas.height / 2);
  }

  zoomBy(factor: number): void {
    this.zoomTo(this.view.scale * factor);
  }

  private minScale(): number {
    if (!this.hasImage) return 0.01;
    const fitScale = Math.min(this.canvas.width / this.imageWidth, this.canvas.height / this.imageHeight);
    return Math.min(fitScale / 4, 1);
  }

  /** Zooms keeping device-pixel point (px, py) fixed on screen. */
  private zoomAround(scale: number, px: number, py: number): void {
    if (!this.hasImage) return;
    const next = Math.min(MAX_SCALE, Math.max(this.minScale(), scale));
    const k = next / this.view.scale;
    this.view = {
      scale: next,
      originX: px - (px - this.view.originX) * k,
      originY: py - (py - this.view.originY) * k,
    };
    this.fitted = false;
    this.changed();
  }

  private dpr(): number {
    return window.devicePixelRatio || 1;
  }

  private resize(): void {
    const rect = this.element.getBoundingClientRect();
    const dpr = this.dpr();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (w === this.canvas.width && h === this.canvas.height) return;

    // Keep the image point at the view center where it was.
    const cx = (this.canvas.width / 2 - this.view.originX) / this.view.scale;
    const cy = (this.canvas.height / 2 - this.view.originY) / this.view.scale;
    this.canvas.width = w;
    this.canvas.height = h;
    // Resizing clears the canvas, so always redraw (even with no image).
    this.requestRender();
    if (this.fitted) {
      this.fit();
    } else {
      this.view.originX = w / 2 - cx * this.view.scale;
      this.view.originY = h / 2 - cy * this.view.scale;
      this.changed();
    }
  }

  private changed(): void {
    this.zoomLabel.textContent = `${Math.round(this.view.scale * 100)}%`;
    this.options.onViewChange?.(this.view.scale);
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.renderer.render(this.view);
    });
  }

  private devicePoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
  }

  private bindInteractions(): void {
    const c = this.canvas;

    c.addEventListener(
      "wheel",
      (e) => {
        if (!this.hasImage) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        // Trackpad pinch arrives as ctrlKey + wheel with small deltas; make it more responsive.
        const speed = e.ctrlKey ? 0.01 : 0.0015;
        const factor = Math.exp(-e.deltaY * unit * speed);
        const p = this.devicePoint(e);
        this.zoomAround(this.view.scale * factor, p.x, p.y);
      },
      { passive: false },
    );

    c.addEventListener("pointerdown", (e) => {
      if (!this.hasImage) return;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, this.devicePoint(e));
      this.pressStart = this.pointers.size === 1 ? { x: e.clientX, y: e.clientY, moved: false } : null;
      this.startGesture();
      c.classList.add("panning");
    });

    c.addEventListener("pointermove", (e) => {
      if (this.pickHandler && this.pointers.size === 0) this.pickHandler.onHover(e.clientX, e.clientY);
      if (!this.pointers.has(e.pointerId) || !this.gesture) return;
      if (this.pressStart && Math.hypot(e.clientX - this.pressStart.x, e.clientY - this.pressStart.y) > CLICK_SLOP) {
        this.pressStart.moved = true;
      }
      // In pick mode, small jitter during a click must not nudge the view.
      if (this.pickHandler && this.pressStart && !this.pressStart.moved) return;
      this.pointers.set(e.pointerId, this.devicePoint(e));
      const { midX, midY, dist } = this.pointerSummary();
      const g = this.gesture;
      const scale =
        this.pointers.size >= 2 && g.dist > 0
          ? Math.min(MAX_SCALE, Math.max(this.minScale(), (g.scale * dist) / g.dist))
          : g.scale;
      // The image point that was under the gesture's start midpoint follows the current midpoint.
      const ix = (g.midX - g.originX) / g.scale;
      const iy = (g.midY - g.originY) / g.scale;
      this.view = { scale, originX: midX - ix * scale, originY: midY - iy * scale };
      this.fitted = false;
      this.changed();
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      const press = this.pressStart;
      this.pressStart = null;
      if (e.type === "pointerup" && this.pickHandler && press && !press.moved && this.pointers.size === 0) {
        this.pickHandler.onPick(e.clientX, e.clientY);
      }
      if (this.pointers.size > 0) this.startGesture();
      else {
        this.gesture = null;
        c.classList.remove("panning");
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);

    c.addEventListener("pointerleave", () => this.pickHandler?.onLeave());

    c.addEventListener("dblclick", (e) => {
      if (!this.hasImage || this.pickHandler) return;
      const p = this.devicePoint(e);
      if (Math.abs(this.view.scale - 1) < 0.01) this.fit();
      else this.zoomAround(1, p.x, p.y);
    });
  }

  /** Restarts the gesture baseline whenever the number of fingers changes. */
  private startGesture(): void {
    const { midX, midY, dist } = this.pointerSummary();
    this.gesture = { scale: this.view.scale, originX: this.view.originX, originY: this.view.originY, midX, midY, dist };
  }

  private pointerSummary(): { midX: number; midY: number; dist: number } {
    const pts = [...this.pointers.values()];
    const a = pts[0] ?? { x: 0, y: 0 };
    const b = pts[1];
    if (!b) return { midX: a.x, midY: a.y, dist: 0 };
    return { midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private bindDrop(): void {
    const el = this.element;
    let depth = 0;
    el.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      depth++;
      el.classList.add("drag-over");
    });
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.classList.remove("drag-over");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      el.classList.remove("drag-over");
      if (e.dataTransfer?.files.length) this.options.onFilesDropped(e.dataTransfer.files);
    });
  }
}
