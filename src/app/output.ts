// Output size: how many output pixels (the export's pixel grid) each image
// pixel becomes. Halftone sizes are measured in output pixels, so the preview
// uses this to show dots at the size they will be exported.

import type { ProjectSettings } from "../schema/sections";

export function outputWidth(settings: ProjectSettings, imageWidth: number): number {
  const e = settings.export;
  if (settings.upload.mode === "print") return Math.max(1, Math.round(e.printWidth * e.dpi));
  if (e.digitalSize === "double") return imageWidth * 2;
  if (e.digitalSize === "custom") return Math.max(1, e.digitalWidth);
  return imageWidth;
}

/** Output pixels per image pixel. */
export function outputScale(settings: ProjectSettings, imageWidth: number): number {
  return outputWidth(settings, imageWidth) / Math.max(1, imageWidth);
}
