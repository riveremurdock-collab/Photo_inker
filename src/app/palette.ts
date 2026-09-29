// Palette actions shared by the palette panel, the eyedropper, color schemes,
// and auto palette.
// Inks are stored as per-ink settings in slots 0..inkCount-1; slot order is
// print order, so reordering permutes every per-ink setting in the project.

import { MAX_INKS } from "../pipeline/coverage";
import { autoPalette } from "./autoPalette";
import { generateScheme, type SchemeId } from "./colorSchemes";
import type { SourceStore } from "./source";
import type { SettingsStore } from "./store";

/** Colors tried, in order, for a newly added ink (the first one not already in the palette). */
const NEW_INK_COLORS = ["#0078bf", "#ff48b0", "#ffe800", "#000000", "#00a95c", "#ff6c2f", "#765ba7"];

export class PaletteActions {
  /** Paper color from before a scheme's background took it over. */
  private paperBeforeScheme: string | null = null;

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
    // Schemes regenerate when the scheme, its first color, or the background option changes.
    store.subscribe((settings, change) => {
      if (settings.palette.source !== "scheme" || change.section !== "palette") return;
      if (change.key === "source" && change.commit) {
        // Entering Scheme mode: the current ink 1 becomes the scheme's first color.
        const first = settings.palette.inkColor[0] ?? "#0078bf";
        if (first !== settings.palette.schemeBase) this.store.set("palette", "schemeBase", first);
        else this.runScheme();
      } else if (change.key === "schemeIncludeBackground") {
        // Turning the background option off gives back the paper you had before.
        if (settings.palette.schemeIncludeBackground) this.paperBeforeScheme = settings.palette.paper;
        else if (this.paperBeforeScheme) this.store.set("palette", "paper", this.paperBeforeScheme);
        this.runScheme();
      } else if (change.key === "scheme" || change.key === "schemeBase") {
        // The first color regenerates live while dragging the color picker.
        this.runScheme(change.commit);
      }
    });
    source.subscribe(() => {
      if (store.get().palette.source === "auto") this.runAuto();
    });
  }

  private get palette() {
    return this.store.get().palette;
  }

  /** A manual edit leaves Auto or Scheme mode, keeping the current colors. */
  private leaveGenerated(): void {
    if (this.palette.source !== "manual") this.store.set("palette", "source", "manual");
  }

  setInkColor(slot: number, hex: string, commit = true): void {
    const p = this.palette;
    // In Scheme mode, ink 1 is the scheme's first color: changing it regenerates the rest.
    if (p.source === "scheme" && slot === 0 && p.scheme !== "cmyk") {
      this.store.set("palette", "schemeBase", hex, { commit });
      return;
    }
    this.leaveGenerated();
    this.store.setInkValue("palette", "inkColor", slot, hex, { commit });
  }

  setPaper(hex: string, commit = true): void {
    // Picking the paper by hand only leaves Auto/Scheme if they were choosing the paper.
    const p = this.palette;
    if ((p.source === "auto" && p.autoIncludeBackground) || (p.source === "scheme" && p.schemeIncludeBackground)) {
      this.leaveGenerated();
    }
    this.store.set("palette", "paper", hex, { commit });
  }

  addInk(): void {
    // A scheme locks in its number of colors, so adding an ink switches to Manual.
    if (this.palette.source === "scheme") this.leaveGenerated();
    const count = this.palette.inkCount;
    if (count >= MAX_INKS) return;
    const used = new Set(this.palette.inkColor.slice(0, count));
    const color = NEW_INK_COLORS.find((c) => !used.has(c)) ?? "#000000";
    this.store.resetInkSlot(count);
    this.store.setInkValue("palette", "inkColor", count, color);
    this.store.set("palette", "inkCount", count + 1);
  }

  removeInk(slot: number): void {
    if (this.palette.source === "scheme") this.leaveGenerated();
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

  /** Builds the palette from the chosen scheme and its first color. */
  runScheme(commit = true): void {
    const p = this.palette;
    const result = generateScheme(p.scheme as SchemeId, p.schemeBase, p.schemeIncludeBackground);
    const count = Math.min(MAX_INKS, result.inks.length);
    // New ink slots start from default per-ink settings, as when adding an ink.
    for (let i = p.inkCount; i < count; i++) this.store.resetInkSlot(i);
    const colors = this.palette.inkColor.slice();
    result.inks.slice(0, count).forEach((hex, i) => (colors[i] = hex));
    this.store.setValue("palette", "inkColor", colors, { commit });
    if (count !== p.inkCount) this.store.set("palette", "inkCount", count, { commit });
    if (result.paper) this.store.set("palette", "paper", result.paper, { commit });
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
