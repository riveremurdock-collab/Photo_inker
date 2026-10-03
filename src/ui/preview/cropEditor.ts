// Crop & rotate editor: an overlay on the preview showing the whole photo
// (turned and straightened) with a crop box to drag, the outside dimmed.
//
// Edits are local until Done, which sets every geometry setting at once (one
// undo step); Cancel or Escape discards them. The photo is drawn from a small
// copy on a 2D canvas, so dragging and straightening are instant; the full
// image is only rebuilt on Done (app/crop.ts).
//
// The crop box always stays inside the tilted photo: straightening shrinks it
// as needed (from the box you had before you started straightening, so moving
// the slider back gives it back), and dragging stops at the photo's edge.

import { drawGeometry, fitBetween, FULL, geometryOf, isIdentity, keepInside, largestRect, toFrac, toPx, turnedSize, type Rect, type Turn } from "../../app/crop";
import type { SettingsStore } from "../../app/store";
import { outputLayout } from "../../app/layout";

/** The longest edge of the copy the editor draws from. */
const DISPLAY_EDGE = 2048;
/** Smallest crop, in turned-frame px. */
const MIN_CROP = 16;
/** Handle grab distance, CSS px. */
const GRAB = 14;

const RATIOS: { value: string; label: string; ratio: number | null }[] = [
  { value: "free", label: "Free", ratio: null },
  { value: "original", label: "Original", ratio: null },
  { value: "page", label: "Page", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:5", label: "4:5", ratio: 4 / 5 },
  { value: "2:3", label: "2:3", ratio: 2 / 3 },
  { value: "3:4", label: "3:4", ratio: 3 / 4 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
];

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface CropEditorOptions {
  store: SettingsStore;
  /** The photo as uploaded (before any crop or rotation). */
  original(): ImageBitmap | null;
}

export class CropEditor {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private display: { source: ImageBitmap; display: ImageBitmap } | null = null;
  private isOpen = false;

  // Local state while editing.
  private turn: Turn = 0;
  private straighten = 0;
  /** Crop, turned-frame px. */
  private crop: Rect = { x: 0, y: 0, w: 1, h: 1 };
  /** The crop before straightening started, so straightening back restores it. */
  private intended: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private ratio = "free";
  /** Swap the chosen ratio to the other orientation. */
  private swapped = false;
  private width = 1;
  private height = 1;

  // View: frame px → canvas px.
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag: { handle: Handle; start: Rect; fx: number; fy: number } | null = null;
  private straightening = false;

  private ratioSelect: HTMLSelectElement;
  private swapButton: HTMLButtonElement;
  private straightenRange: HTMLInputElement;
  private straightenNumber: HTMLInputElement;
  private fields: Record<"x" | "y" | "w" | "h", HTMLInputElement>;

  constructor(private options: CropEditorOptions) {
    this.element = document.createElement("div");
    this.element.className = "crop-editor";
    this.element.hidden = true;
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Crop and rotate");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "crop-canvas";
    this.ctx = this.canvas.getContext("2d")!;

    const bar = document.createElement("div");
    bar.className = "crop-toolbar";
    const group = (...children: HTMLElement[]) => {
      const g = document.createElement("div");
      g.className = "crop-group";
      g.append(...children);
      return g;
    };
    const button = (text: string, title: string, onClick: () => void, className = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = title;
      b.setAttribute("aria-label", title);
      if (className) b.className = className;
      b.addEventListener("click", onClick);
      return b;
    };
    const label = (text: string) => {
      const l = document.createElement("span");
      l.className = "crop-label";
      l.textContent = text;
      return l;
    };

    this.ratioSelect = document.createElement("select");
    this.ratioSelect.setAttribute("aria-label", "Aspect ratio");
    for (const r of RATIOS) {
      const o = document.createElement("option");
      o.value = r.value;
      o.textContent = r.label;
      this.ratioSelect.append(o);
    }
    this.ratioSelect.addEventListener("change", () => this.setRatio(this.ratioSelect.value));
    this.swapButton = button("⇄", "Swap portrait / landscape", () => {
      this.swapped = !this.swapped;
      this.applyRatio();
    });

    this.straightenRange = document.createElement("input");
    this.straightenRange.type = "range";
    this.straightenRange.min = "-45";
    this.straightenRange.max = "45";
    this.straightenRange.step = "0.1";
    this.straightenRange.setAttribute("aria-label", "Straighten");
    this.straightenNumber = document.createElement("input");
    this.straightenNumber.type = "number";
    this.straightenNumber.className = "control-number";
    this.straightenNumber.min = "-45";
    this.straightenNumber.max = "45";
    this.straightenNumber.step = "0.1";
    this.straightenNumber.setAttribute("aria-label", "Straighten angle");
    this.straightenRange.addEventListener("input", () => this.setStraighten(Number(this.straightenRange.value), true));
    this.straightenRange.addEventListener("change", () => this.endStraighten());
    this.straightenNumber.addEventListener("change", () => {
      this.setStraighten(Number(this.straightenNumber.value), false);
      this.endStraighten();
    });

    const field = (name: string) => {
      const n = document.createElement("input");
      n.type = "number";
      n.className = "control-number crop-field";
      n.min = "0";
      n.step = "1";
      n.setAttribute("aria-label", `Crop ${name}, px`);
      n.addEventListener("change", () => this.typed());
      return n;
    };
    this.fields = { x: field("left"), y: field("top"), w: field("width"), h: field("height") };

    bar.append(
      group(label("Aspect"), this.ratioSelect, this.swapButton),
      group(button("⟲", "Rotate left 90°", () => this.turnBy(-90)), button("⟳", "Rotate right 90°", () => this.turnBy(90))),
      group(label("Straighten"), this.straightenRange, this.straightenNumber, label("°")),
      group(label("X"), this.fields.x, label("Y"), this.fields.y, label("W"), this.fields.w, label("H"), this.fields.h, label("px")),
      group(
        button("Reset", "Undo every crop and rotation", () => this.reset()),
        button("Cancel", "Close without changes (Esc)", () => this.close()),
        button("Done", "Apply the crop (Enter)", () => this.done(), "crop-done"),
      ),
    );
    this.element.append(this.canvas, bar);

    this.canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.pointerUp(e));
    this.element.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        this.done();
      }
    });
    new ResizeObserver(() => this.isOpen && this.draw()).observe(this.element);
  }

  get open(): boolean {
    return this.isOpen;
  }

  async show(): Promise<void> {
    const source = this.options.original();
    if (!source) return;
    if (this.display?.source !== source) {
      this.display?.display.close();
      const k = Math.min(1, DISPLAY_EDGE / Math.max(source.width, source.height));
      const display = await createImageBitmap(source, { resizeWidth: Math.max(1, Math.round(source.width * k)), resizeHeight: Math.max(1, Math.round(source.height * k)), resizeQuality: "high" });
      this.display = { source, display };
    }
    this.width = source.width;
    this.height = source.height;
    const g = geometryOf(this.options.store.get().adjust as unknown as Record<string, unknown>);
    this.turn = g.turn;
    this.straighten = g.straighten;
    const [W, H] = this.frame();
    this.crop = toPx(g.crop, W, H);
    this.intended = this.crop;
    this.ratio = "free";
    this.swapped = false;
    this.ratioSelect.value = "free";
    this.isOpen = true;
    this.element.hidden = false;
    this.syncControls();
    this.draw();
    this.element.querySelector<HTMLButtonElement>(".crop-done")?.focus();
  }

  close(): void {
    this.isOpen = false;
    this.element.hidden = true;
  }

  private frame(): [number, number] {
    return turnedSize(this.width, this.height, this.turn);
  }

  // ---- Edits ----

  private done(): void {
    const [W, H] = this.frame();
    const f = toFrac(this.crop, W, H);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const s = this.options.store.get();
    // One change (one undo step) for the whole geometry.
    this.options.store.replace({
      ...s,
      adjust: { ...s.adjust, turn: this.turn, straighten: Math.round(this.straighten * 10) / 10, cropX: clamp(f.x), cropY: clamp(f.y), cropW: clamp(f.w), cropH: clamp(f.h) },
    });
    this.close();
  }

  private reset(): void {
    this.turn = 0;
    this.straighten = 0;
    const [W, H] = this.frame();
    this.crop = toPx(FULL, W, H);
    this.intended = this.crop;
    this.ratio = "free";
    this.ratioSelect.value = "free";
    this.syncControls();
    this.draw();
  }

  private turnBy(delta: 90 | -90): void {
    const [W, H] = this.frame();
    const r = this.crop;
    // The crop turns with the photo.
    this.crop = delta > 0 ? { x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w } : { x: r.y, y: W - (r.x + r.w), w: r.h, h: r.w };
    this.intended = this.crop;
    this.turn = (((this.turn + delta) % 360) + 360) % 360 as Turn;
    if (this.ratio !== "free" && this.ratio !== "original" && this.ratio !== "page") this.swapped = !this.swapped;
    const [W2, H2] = this.frame();
    this.crop = keepInside(this.crop, W2, H2, this.straighten);
    this.syncControls();
    this.draw();
  }

  private setStraighten(deg: number, live: boolean): void {
    if (!Number.isFinite(deg)) return;
    if (!this.straightening) {
      this.straightening = true;
      this.intended = this.crop;
    }
    this.straighten = Math.max(-45, Math.min(45, deg));
    const [W, H] = this.frame();
    this.crop = keepInside(this.intended, W, H, this.straighten);
    this.syncControls(live ? "range" : undefined);
    this.draw();
  }

  private endStraighten(): void {
    this.straightening = false;
    this.draw();
  }

  /** The chosen ratio (width / height), or null for free. */
  private ratioValue(): number | null {
    const [W, H] = this.frame();
    let r: number | null;
    if (this.ratio === "original") r = W / H;
    else if (this.ratio === "page") {
      const p = outputLayout(this.options.store.get(), 1000, 1000).printable;
      r = p ? p.width / p.height : null;
    } else r = RATIOS.find((x) => x.value === this.ratio)?.ratio ?? null;
    if (r && this.swapped) r = 1 / r;
    return r;
  }

  private setRatio(value: string): void {
    this.ratio = value;
    // Start in the crop's current orientation.
    const r = RATIOS.find((x) => x.value === value)?.ratio;
    this.swapped = r !== undefined && r !== null && r !== 1 && (this.crop.w >= this.crop.h) !== (r >= 1);
    this.applyRatio();
  }

  /** Reshapes the crop to the ratio: as large as fits, centered where the crop is. */
  private applyRatio(): void {
    const ratio = this.ratioValue();
    if (!ratio) return this.draw();
    const [W, H] = this.frame();
    const big = largestRect(W, H, this.straighten, ratio);
    const cx = this.crop.x + this.crop.w / 2;
    const cy = this.crop.y + this.crop.h / 2;
    const target = { ...big, x: cx - big.w / 2, y: cy - big.h / 2 };
    this.crop = fitBetween(big, target, W, H, this.straighten);
    this.intended = this.crop;
    this.syncControls();
    this.draw();
  }

  private typed(): void {
    const v = (k: "x" | "y" | "w" | "h") => Number(this.fields[k].value);
    const ratio = this.ratioValue();
    let w = Math.max(MIN_CROP, v("w"));
    let h = Math.max(MIN_CROP, v("h"));
    if (ratio) {
      // With a ratio, whichever of width and height was just typed decides the other.
      if (document.activeElement === this.fields.h) w = h * ratio;
      else h = w / ratio;
    }
    const target = { x: v("x"), y: v("y"), w, h };
    if ([target.x, target.y, target.w, target.h].every(Number.isFinite)) {
      const [W, H] = this.frame();
      this.crop = fitBetween(this.crop, target, W, H, this.straighten);
      this.intended = this.crop;
    }
    this.syncControls();
    this.draw();
  }

  // ---- Dragging ----

  private toFrame(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    return [((e.clientX - rect.left) * dpr - this.ox) / this.scale, ((e.clientY - rect.top) * dpr - this.oy) / this.scale];
  }

  private handleAt(fx: number, fy: number): Handle | null {
    const rect = this.canvas.getBoundingClientRect();
    const grab = (GRAB * (this.canvas.width / Math.max(1, rect.width))) / this.scale;
    const r = this.crop;
    const nearL = Math.abs(fx - r.x) < grab;
    const nearR = Math.abs(fx - (r.x + r.w)) < grab;
    const nearT = Math.abs(fy - r.y) < grab;
    const nearB = Math.abs(fy - (r.y + r.h)) < grab;
    const inX = fx > r.x - grab && fx < r.x + r.w + grab;
    const inY = fy > r.y - grab && fy < r.y + r.h + grab;
    if (nearT && nearL) return "nw";
    if (nearT && nearR) return "ne";
    if (nearB && nearL) return "sw";
    if (nearB && nearR) return "se";
    if (nearT && inX) return "n";
    if (nearB && inX) return "s";
    if (nearL && inY) return "w";
    if (nearR && inY) return "e";
    if (fx > r.x && fx < r.x + r.w && fy > r.y && fy < r.y + r.h) return "move";
    return null;
  }

  private pointerDown(e: PointerEvent): void {
    const [fx, fy] = this.toFrame(e);
    const handle = this.handleAt(fx, fy);
    if (!handle) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { handle, start: this.crop, fx, fy };
  }

  private pointerMove(e: PointerEvent): void {
    const [fx, fy] = this.toFrame(e);
    if (!this.drag) {
      const h = this.handleAt(fx, fy);
      const cursors: Record<Handle, string> = { move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
      this.canvas.style.cursor = h ? cursors[h] : "default";
      return;
    }
    const { handle, start } = this.drag;
    const dx = fx - this.drag.fx;
    const dy = fy - this.drag.fy;
    const [W, H] = this.frame();
    let target: Rect;
    if (handle === "move") target = { ...start, x: start.x + dx, y: start.y + dy };
    else target = this.resized(start, handle, dx, dy);
    this.crop = fitBetween(this.crop, target, W, H, this.straighten);
    this.intended = this.crop;
    this.syncControls();
    this.draw();
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.draw();
  }

  /** The crop with one edge or corner moved (keeping the ratio, if one is chosen). */
  private resized(r: Rect, handle: Handle, dx: number, dy: number): Rect {
    let x0 = r.x;
    let y0 = r.y;
    let x1 = r.x + r.w;
    let y1 = r.y + r.h;
    if (handle.includes("w")) x0 = Math.min(x1 - MIN_CROP, x0 + dx);
    if (handle.includes("e")) x1 = Math.max(x0 + MIN_CROP, x1 + dx);
    if (handle.includes("n")) y0 = Math.min(y1 - MIN_CROP, y0 + dy);
    if (handle.includes("s")) y1 = Math.max(y0 + MIN_CROP, y1 + dy);
    const ratio = this.ratioValue();
    if (!ratio) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    let w = x1 - x0;
    let h = y1 - y0;
    if (handle === "n" || handle === "s") w = h * ratio;
    else if (handle === "e" || handle === "w") h = w / ratio;
    else if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
    // Keep the opposite corner (or, for an edge, the opposite edge's middle) in place.
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const x = handle.includes("w") ? x1 - w : handle.includes("e") ? x0 : cx - w / 2;
    const y = handle.includes("n") ? y1 - h : handle.includes("s") ? y0 : cy - h / 2;
    return { x, y, w, h };
  }

  // ---- Display ----

  private syncControls(skip?: "range"): void {
    if (skip !== "range") this.straightenRange.value = String(this.straighten);
    this.straightenNumber.value = this.straighten.toFixed(1);
    const r = this.crop;
    for (const [k, v] of [["x", r.x], ["y", r.y], ["w", r.w], ["h", r.h]] as const) {
      if (document.activeElement !== this.fields[k]) this.fields[k].value = String(Math.round(v));
    }
    const ratioOn = this.ratio !== "free";
    this.swapButton.disabled = !ratioOn || this.ratio === "original" || this.ratio === "page";
    const page = this.ratioSelect.querySelector<HTMLOptionElement>('option[value="page"]')!;
    const s = this.options.store.get();
    page.hidden = s.upload.mode !== "print" || s.export.pageSize === "image";
  }

  private draw(): void {
    if (!this.isOpen || !this.display) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    const [W, H] = this.frame();
    const pad = 28 * dpr;
    this.scale = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
    this.ox = (cw - W * this.scale) / 2;
    this.oy = (ch - H * this.scale) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#2f2f2a";
    ctx.fillRect(0, 0, cw, ch);
    // The whole photo, turned and straightened.
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    ctx.imageSmoothingQuality = "high";
    drawGeometry(ctx, this.display.display, this.width, this.height, { turn: this.turn, straighten: this.straighten, crop: FULL });

    // Dim everything outside the crop.
    const r = this.crop;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const X = (v: number) => this.ox + v * this.scale;
    const Y = (v: number) => this.oy + v * this.scale;
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(X(r.x), Y(r.y), r.w * this.scale, r.h * this.scale);
    ctx.fillStyle = "rgba(20, 20, 18, 0.62)";
    ctx.fill("evenodd");

    // Grid: thirds normally, finer while straightening (to line up with the horizon).
    const lines = this.straightening ? 8 : 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.beginPath();
    for (let i = 1; i < lines; i++) {
      const gx = X(r.x + (r.w * i) / lines);
      const gy = Y(r.y + (r.h * i) / lines);
      ctx.moveTo(gx, Y(r.y));
      ctx.lineTo(gx, Y(r.y + r.h));
      ctx.moveTo(X(r.x), gy);
      ctx.lineTo(X(r.x + r.w), gy);
    }
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(X(r.x), Y(r.y), r.w * this.scale, r.h * this.scale);

    // Corner handles.
    const len = 18 * dpr;
    const t = 4 * dpr;
    ctx.fillStyle = "#ffffff";
    const x0 = X(r.x);
    const y0 = Y(r.y);
    const x1 = X(r.x + r.w);
    const y1 = Y(r.y + r.h);
    for (const [cx, cy, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ] as const) {
      // An L along the two edges, pointing into the crop.
      ctx.fillRect(sx > 0 ? cx - t / 2 : cx - len + t / 2, cy - t / 2, len, t);
      ctx.fillRect(cx - t / 2, sy > 0 ? cy - t / 2 : cy - len + t / 2, t, len);
    }
    // Edge handles.
    for (const [cx, cy, horizontal] of [
      [(x0 + x1) / 2, y0, true],
      [(x0 + x1) / 2, y1, true],
      [x0, (y0 + y1) / 2, false],
      [x1, (y0 + y1) / 2, false],
    ] as const) {
      if (horizontal) ctx.fillRect(cx - len / 2, cy - t / 2, len, t);
      else ctx.fillRect(cx - t / 2, cy - len / 2, t, len);
    }
  }
}

/** Short description of the current geometry for the panel, or null if the photo is as uploaded. */
export function describeGeometry(adjust: Record<string, unknown>, width: number, height: number): string | null {
  const g = geometryOf(adjust);
  if (isIdentity(g)) return null;
  const parts: string[] = [];
  const full = g.crop.x <= 1e-6 && g.crop.y <= 1e-6 && g.crop.w >= 1 - 1e-6 && g.crop.h >= 1 - 1e-6;
  if (!full || Math.abs(g.straighten) > 1e-6) parts.push(`cropped to ${width} × ${height} px`);
  if (g.turn) parts.push(`turned ${g.turn}°`);
  if (Math.abs(g.straighten) > 1e-6) parts.push(`straightened ${g.straighten > 0 ? "+" : ""}${g.straighten.toFixed(1)}°`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}
