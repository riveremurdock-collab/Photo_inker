// Palette actions shared by the palette panel, the eyedropper, and auto palette.
// Inks are stored as per-ink settings in slots 0..inkCount-1; slot order is
// print order, so reordering permutes every per-ink setting in the project.

import { MAX_INKS } from "../pipeline/coverage";
import { autoPalette } from "./autoPalette";
import type { SourceStore } from "./source";
import type { SettingsStore } from "./store";

/** Colors tried, in order, for a newly added ink (the first one not already in the palette). */
const NEW_INK_COLORS = ["#0078bf", "#ff48b0", "#ffe800", "#000000", "#00a95c", "#ff6c2f", "#765ba7"];

export class PaletteActions {
  constructor(
    private store: SettingsStore,
    private source: SourceStore,
  ) {
    // Auto palette reruns when anything it depends on changes.
    store.subscribe((settings, change) => {
      if (settings.palette.source !== "auto" || !change.commit) return;
      const triggers =
        change.section === "palette" &&
        (change.key === "source" ||
          change.key === "inkCount" ||
          change.key === "autoIncludeBackground" ||
          (change.key === "paper" && !settings.palette.autoIncludeBackground));
      if (triggers) this.runAuto();
    });
    source.subscribe(() => {
      if (store.get().palette.source === "auto") this.runAuto();
    });
  }

  private get palette() {
    return this.store.get().palette;
  }

  /** A manual color edit leaves Auto mode, keeping the current colors. */
  private leaveAuto(): void {
    if (this.palette.source === "auto") this.store.set("palette", "source", "manual");
  }

  setInkColor(slot: number, hex: string, commit = true): void {
    this.leaveAuto();
    this.store.setInkValue("palette", "inkColor", slot, hex, { commit });
  }

  setPaper(hex: string, commit = true): void {
    // Picking the paper by hand only leaves Auto if Auto was choosing the paper.
    if (this.palette.source === "auto" && this.palette.autoIncludeBackground) this.leaveAuto();
    this.store.set("palette", "paper", hex, { commit });
  }

  addInk(): void {
    const count = this.palette.inkCount;
    if (count >= MAX_INKS) return;
    const used = new Set(this.palette.inkColor.slice(0, count));
    const color = NEW_INK_COLORS.find((c) => !used.has(c)) ?? "#000000";
    this.store.resetInkSlot(count);
    this.store.setInkValue("palette", "inkColor", count, color);
    this.store.set("palette", "inkCount", count + 1);
  }

  removeInk(slot: number): void {
    const count = this.palette.inkCount;
    if (count <= 1) return;
    // Move the removed ink to the end (its settings are kept there, unused), then shrink.
    const order = [...Array(MAX_INKS).keys()].filter((i) => i !== slot);
    order.push(slot);
    this.store.permuteInks(order);
    this.store.set("palette", "inkCount", count - 1);
  }

  /** Moves an ink one place earlier (-1) or later (+1) in print order. */
  moveInk(slot: number, direction: -1 | 1): void {
    const target = slot + direction;
    if (target < 0 || target >= this.palette.inkCount) return;
    const order = [...Array(MAX_INKS).keys()];
    order[slot] = target;
    order[target] = slot;
    this.store.permuteInks(order);
  }

  /** Picks inks (and optionally the paper) from the image. Does nothing without an image. */
  runAuto(): void {
    const image = this.source.get();
    if (!image) return;
    const { inkCount, autoIncludeBackground, paper } = this.palette;
    const result = autoPalette(image.bitmap, inkCount, autoIncludeBackground ? null : paper);

    const colors = this.palette.inkColor.slice();
    result.inks.forEach((hex, i) => (colors[i] = hex));
    this.store.setValue("palette", "inkColor", colors);
    if (autoIncludeBackground) this.store.set("palette", "paper", result.paper);
  }
}
