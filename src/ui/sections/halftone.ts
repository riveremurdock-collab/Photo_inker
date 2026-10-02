// AM halftone custom blocks: one-click screen angle presets for the square
// and hex grids. The per-ink angle sliders below them (generated from the
// schema) can then be fine-tuned.

import type { SettingsStore } from "../../app/store";
import { MAX_INKS } from "../../pipeline/coverage";
import { STANDARD_ANGLES } from "../../plugins/halftone/amSquare";

interface AnglePreset {
  label: string;
  title: string;
  angles: number[];
}

const SQUARE_PRESETS: AnglePreset[] = [
  {
    label: "Standard",
    title: "15°, 75°, 0°, 45° by print order (the classic CMYK set, which avoids moiré)",
    angles: STANDARD_ANGLES,
  },
  { label: "All 45°", title: "Every ink at 45°", angles: [45, 45, 45, 45] },
  { label: "All 0°", title: "Every ink at 0°", angles: [0, 0, 0, 0] },
];

// A hex grid repeats every 60°, so 15° apart is as far as two hex screens can differ.
const HEX_PRESETS: AnglePreset[] = [
  { label: "Standard", title: "0°, 30°, 15°, 45° by print order (15° apart, the most two hex screens can differ)", angles: [0, 30, 15, 45] },
  { label: "All 30°", title: "Every ink at 30°", angles: [30, 30, 30, 30] },
  { label: "All 0°", title: "Every ink at 0°", angles: [0, 0, 0, 0] },
];

function anglePresets(store: SettingsStore, sectionId: string, presets: AnglePreset[]): HTMLElement {
  const element = document.createElement("div");
  element.className = "control";
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = "Angle presets";
  const row = document.createElement("div");
  row.className = "button-row";
  for (const preset of presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = preset.label;
    b.title = preset.title;
    b.addEventListener("click", () => store.setValue(sectionId, "angle", preset.angles.slice(0, MAX_INKS)));
    row.append(b);
  }
  element.append(label, row);
  return element;
}

export const createAmBlock = (store: SettingsStore) => anglePresets(store, "halftoneAm", SQUARE_PRESETS);
export const createHexBlock = (store: SettingsStore) => anglePresets(store, "halftoneHex", HEX_PRESETS);
