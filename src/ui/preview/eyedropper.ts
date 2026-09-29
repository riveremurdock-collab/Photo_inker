// Eyedropper on the base image. While active, hovering shows a loupe with the
// color under the cursor; clicking picks it; Escape or a second click on the
// eyedropper button cancels. Samples average a 3×3 pixel area in linear light,
// so a single noisy pixel doesn't decide the color.

import { linearToSrgbChannel, rgbToHex, srgbToLinearChannel } from "../../util/color";
import type { Preview } from "./preview";

export type PickTarget =
  | { kind: "ink"; slot: number }
  | { kind: "paper" }
  /** Anything else that wants a color from the image (e.g. a Selective Color range). */
  | { kind: "custom"; id: string; onPick: (hex: string) => void };

const SAMPLE_RADIUS = 1;

export function sameTarget(a: PickTarget | null, b: PickTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "ink") return a.slot === (b as { slot: number }).slot;
  if (a.kind === "custom") return a.id === (b as { id: string }).id;
  return true;
}

export class Eyedropper {
  private target: PickTarget | null = null;
  private listeners = new Set<(target: PickTarget | null) => void>();
  private loupe: HTMLElement;
  private sampler = new OffscreenCanvas(SAMPLE_RADIUS * 2 + 1, SAMPLE_RADIUS * 2 + 1);
  private samplerCtx = this.sampler.getContext("2d", { willReadFrequently: true })!;

  constructor(
    private preview: Preview,
    private getBitmap: () => ImageBitmap | null,
    private onPicked: (target: PickTarget, hex: string) => void,
  ) {
    this.loupe = document.createElement("div");
    this.loupe.className = "loupe";
    this.loupe.hidden = true;
    preview.element.append(this.loupe);

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.target) this.stop();
    });
  }

  get active(): PickTarget | null {
    return this.target;
  }

  toggle(target: PickTarget): void {
    if (sameTarget(this.target, target)) this.stop();
    else this.start(target);
  }

  start(target: PickTarget): void {
    if (!this.getBitmap()) return;
    this.target = target;
    this.preview.setPickHandler({
      onHover: (x, y) => this.hover(x, y),
      onPick: (x, y) => this.pick(x, y),
      onLeave: () => (this.loupe.hidden = true),
    });
    this.notify();
  }

  stop(): void {
    if (!this.target) return;
    this.target = null;
    this.preview.setPickHandler(null);
    this.loupe.hidden = true;
    this.notify();
  }

  subscribe(listener: (target: PickTarget | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l(this.target);
  }

  /** Hex color of the image at a screen position, or null outside the image. */
  sampleAt(clientX: number, clientY: number): string | null {
    const bitmap = this.getBitmap();
    if (!bitmap) return null;
    const p = this.preview.clientToImage(clientX, clientY);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;

    const size = SAMPLE_RADIUS * 2 + 1;
    const ctx = this.samplerCtx;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, x - SAMPLE_RADIUS, y - SAMPLE_RADIUS, size, size, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! === 0) continue; // outside the image edge or fully transparent
      r += srgbToLinearChannel(data[i]! / 255);
      g += srgbToLinearChannel(data[i + 1]! / 255);
      b += srgbToLinearChannel(data[i + 2]! / 255);
      n++;
    }
    if (n === 0) return null;
    const to255 = (v: number) => linearToSrgbChannel(v / n) * 255;
    return rgbToHex({ r: to255(r), g: to255(g), b: to255(b) });
  }

  private hover(clientX: number, clientY: number): void {
    const hex = this.sampleAt(clientX, clientY);
    if (!hex) {
      this.loupe.hidden = true;
      return;
    }
    const rect = this.preview.element.getBoundingClientRect();
    this.loupe.hidden = false;
    this.loupe.style.left = `${clientX - rect.left + 16}px`;
    this.loupe.style.top = `${clientY - rect.top + 16}px`;
    this.loupe.style.setProperty("--loupe-color", hex);
    this.loupe.textContent = hex;
  }

  private pick(clientX: number, clientY: number): void {
    const hex = this.sampleAt(clientX, clientY);
    if (!hex || !this.target) return;
    const target = this.target;
    this.stop();
    this.onPicked(target, hex);
  }
}
