// Preview area: WebGL canvas, zoom/pan/pinch, fit-to-screen, and a small zoom
// toolbar. Zoom math is adapted from the stipple tool's preview (zoom keeps
// the point under the cursor fixed; pan uses pointer capture), rewritten for
// a viewport-sized WebGL canvas and devicePixelRatio.

import { ViewRenderer, type DisplaySource, type ViewTransform, type FrameDisplay } from "./viewRenderer";
import type { BorderGeometry } from "../../app/border";
import { drawPage, pageBounds, type PageView } from "./pageOverlay";

export type DisplayMode = "inks" | "original";

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
  /** Called shortly after zooming/panning stops. */
  onViewSettled?: () => void;
}

/** How long after the last zoom/pan the view counts as settled. */
const SETTLE_DELAY_MS = 160;

export class Preview {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  /** 2D layer over the WebGL canvas for the Print mode page view. */
  private overlay: HTMLCanvasElement;
  private page: PageView | null = null;
  private renderer: ViewRenderer;
  private emptyState: HTMLElement;
  private zoomLabel: HTMLButtonElement;
  private modeButtons: HTMLButtonElement[] = [];
  private sources: Record<DisplayMode, DisplaySource | null> = { inks: null, original: null };
  private displayMode: DisplayMode = "inks";

  private imageWidth = 0;
  private imageHeight = 0;
  /** Image px a border adds around the image on each side (the canvas is bigger than the image). */
  private margin = 0;
  private frame: FrameDisplay | null = null;
  private view: ViewTransform = { scale: 1, originX: 0, originY: 0 };
  /** While true, resizing the window refits the image. Cleared by any manual zoom or pan. */
  private fitted = true;
  private frameRequested = false;
  private interacting = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.overlay = document.createElement("canvas");
    this.overlay.className = "preview-overlay";
    this.element.append(this.canvas, this.overlay);
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
    const modes = document.createElement("div");
    modes.className = "segmented preview-modes";
    for (const [mode, label, title] of [
      ["inks", "Inks", "Show the image printed in your inks (I)"],
      ["original", "Original", "Show the original image (O)"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.dataset.value = mode;
      b.addEventListener("click", () => this.setDisplayMode(mode));
      modes.append(b);
      this.modeButtons.push(b);
    }
    toolbar.append(modes);
    button("−", "Zoom out (−)", () => this.zoomBy(1 / Math.SQRT2));
    this.zoomLabel = button("100%", "Actual pixels (1)", () => this.zoomTo(1));
    this.zoomLabel.classList.add("zoom-label");
    button("+", "Zoom in (+)", () => this.zoomBy(Math.SQRT2));
    button("Fit", "Fit to screen (0)", () => this.fit());
    this.element.append(toolbar);
    toolbar.hidden = true;
    this.setDisplayMode("inks");

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

  /** The WebGL context the preview draws with; pipeline textures must live here to be displayed. */
  get gl(): WebGL2RenderingContext {
    return this.renderer.gl;
  }

  get mode(): DisplayMode {
    return this.displayMode;
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    for (const b of this.modeButtons) {
      const on = b.dataset.value === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    this.renderer.setSource(this.sources[mode]);
    this.requestRender();
  }

  /** Updates what the Inks and Original views show (null = nothing ready yet). */
  setSource(mode: DisplayMode, source: DisplaySource | null): void {
    this.sources[mode] = source;
    if (mode === this.displayMode) {
      this.renderer.setSource(source);
      this.requestRender();
    }
  }

  /**
   * Solid ink / paper border (see app/border.ts), drawn in the Inks view, with
   * its color (linear RGB). A border that grows the canvas refits a fitted view.
   */
  setFrame(geometry: BorderGeometry, color: [number, number, number]): void {
    this.frame = { geometry, color };
    const margin = geometry.margin;
    const refit = margin !== this.margin && this.fitted;
    this.margin = margin;
    if (refit) this.fit();
    this.requestRender();
  }

  /**
   * The Print mode page (sheet, margin guide, marks) around the artwork, or
   * null in Digital mode. The view fits the whole page.
   */
  setPage(page: PageView | null): void {
    const before = this.bounds();
    this.page = page;
    const after = this.bounds();
    if (this.fitted && (before.x0 !== after.x0 || before.y0 !== after.y0 || before.x1 !== after.x1 || before.y1 !== after.y1)) this.fit();
    this.requestRender();
  }

  /** What "fit" shows, in image px: the page, or the image plus any border around it. */
  private bounds(): { x0: number; y0: number; x1: number; y1: number } {
    if (this.page) return pageBounds(this.page);
    return { x0: -this.margin, y0: -this.margin, x1: this.imageWidth + this.margin, y1: this.imageHeight + this.margin };
  }

  /** Called when a new image is loaded: sets the image size and fits it to the screen. */
  setImageSize(width: number, height: number): void {
    this.imageWidth = width;
    this.imageHeight = height;
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
    // Fit the whole page, or the image plus any border around it.
    const b = this.bounds();
    const cw = b.x1 - b.x0;
    const ch = b.y1 - b.y0;
    const scale = Math.min(w / cw, h / ch);
    this.view = {
      scale,
      originX: (this.canvas.width - cw * scale) / 2 - b.x0 * scale,
      originY: (this.canvas.height - ch * scale) / 2 - b.y0 * scale,
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
    const b = this.bounds();
    const fitScale = Math.min(this.canvas.width / (b.x1 - b.x0), this.canvas.height / (b.y1 - b.y0));
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
    this.overlay.width = w;
    this.overlay.height = h;
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
    // While zooming/panning, draw at fast quality; redraw at full quality once it stops.
    this.interacting = true;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.interacting = false;
      this.requestRender();
      this.options.onViewSettled?.();
    }, SETTLE_DELAY_MS);
    this.requestRender();
  }

  /** Current view: device px per image px, and where the image's top-left corner is. */
  get currentView(): ViewTransform {
    return { ...this.view };
  }

  /** Canvas size in device pixels. */
  get canvasSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      // The border belongs to the inked result; the Original view shows the image alone.
      this.renderer.setFrame(this.displayMode === "inks" ? this.frame : null);
      this.renderer.render(this.view, this.imageWidth, this.imageHeight, this.interacting ? "fast" : "full");
      const ctx = this.overlay.getContext("2d")!;
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      if (this.page && this.hasImage) drawPage(ctx, this.page, this.view, this.dpr());
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
