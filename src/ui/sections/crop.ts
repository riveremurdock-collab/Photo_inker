// Image Adjustments: the crop & rotate row. Opens the crop editor over the
// preview, says what the current crop is, and resets it.

import { GEOMETRY_KEYS } from "../../app/crop";
import type { SourceStore } from "../../app/source";
import type { SettingsStore } from "../../app/store";
import { describeGeometry, type CropEditor } from "../preview/cropEditor";

export function createCropBlock(store: SettingsStore, source: SourceStore, editor: CropEditor): HTMLElement {
  const element = document.createElement("div");
  element.className = "control crop-block";
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = "Crop & rotate";
  const row = document.createElement("div");
  row.className = "button-row";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Crop & rotate…";
  open.addEventListener("click", () => void editor.show());
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  reset.title = "Back to the photo as uploaded";
  reset.addEventListener("click", () => {
    const s = store.get();
    const adjust = { ...s.adjust } as Record<string, unknown>;
    for (const key of GEOMETRY_KEYS) adjust[key] = key === "cropW" || key === "cropH" ? 1 : 0;
    store.replace({ ...s, adjust: adjust as typeof s.adjust });
  });
  row.append(open, reset);
  const summary = document.createElement("p");
  summary.className = "control-help";
  element.append(label, row, summary);

  const refresh = () => {
    const image = source.get();
    const text = image ? describeGeometry(store.get().adjust as unknown as Record<string, unknown>, image.width, image.height) : null;
    open.disabled = !image;
    reset.disabled = !text;
    summary.textContent = image ? (text ?? "The photo as uploaded.") : "Upload an image to crop or rotate it.";
  };
  refresh();
  store.subscribe(refresh);
  source.subscribe(refresh);
  return element;
}
