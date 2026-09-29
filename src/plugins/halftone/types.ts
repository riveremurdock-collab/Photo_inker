// Every halftone type implements this interface. One method is chosen for the
// whole image; per-ink settings (size, angle, density) live in perInkSchema.

import type { CoverageSet } from "../../pipeline/coverage";
import type { StageContext } from "../../pipeline/stage";
import type { SettingDef } from "../../schema/types";

/** Whole-image analysis (tone, edges, structure) computed once and shared by all layers. */
export interface ImageAnalysis {
  width: number;
  height: number;
  luminance: Float32Array;
}

export interface HalftoneMethod<S = Record<string, unknown>> {
  id: string;
  label: string;
  family: "none" | "am" | "fm";
  schema: SettingDef[];
  perInkSchema: SettingDef[];
  prepare?(analysis: ImageAnalysis, settings: S, ctx: StageContext): Promise<void>;
  render(coverage: CoverageSet, settings: S, ctx: StageContext): Promise<CoverageSet>;
}
