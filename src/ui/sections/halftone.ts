// AM halftone custom block: one-click screen angle presets. The per-ink angle
// sliders below it (generated from the schema) can then be fine-tuned.

import type { SettingsStore } from "../../app/store";
import { MAX_INKS } from "../../pipeline/coverage";
import { STANDARD_ANGLES } from "../../plugins/halftone/amSquare";

const PRESETS: { label: string; title: string; angles: number[] }[] = [
  {
    label: "Standard",
    title: "15°, 75°, 0°, 45° by print order (the classic CMYK set, which avoids moiré)",
    angles: STANDARD_ANGLES,
  },
  { label: "All 45°", title: "Every ink at 45°", angles: [45, 45, 45, 45] },
  { label: "All 0°", title: "Every ink at 0°", angles: [0, 0, 0, 0] },
];

export function createAmBlock(store: SettingsStore): HTMLElement {
  const element = document.createElement("div");
  element.className = "control";
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = "Angle presets";
  const row = document.createElement("div");
  row.className = "button-row";
  for (const preset of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = preset.label;
    b.title = preset.title;
    b.addEventListener("click", () => store.setValue("halftoneAm", "angle", preset.angles.slice(0, MAX_INKS)));
    row.append(b);
  }
  element.append(label, row);
  return element;
}
