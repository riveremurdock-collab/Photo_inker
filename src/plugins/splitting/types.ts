// Every color splitting method implements this interface: settings schema in,
// ink coverage layers out. Adding a method = one file + one registry line.

import type { CoverageSet } from "../../pipeline/coverage";
import type { StageContext } from "../../pipeline/stage";
import type { SettingDef } from "../../schema/types";

export interface SplitInput {
  width: number;
  height: number;
  /** Adjusted image in linear light, RGBA float. */
  linearRgba: Float32Array;
  /** Ink colors in print order, as sRGB hex. */
  inks: string[];
  paper: string;
}

export interface SplitMethod<S = Record<string, unknown>> {
  id: string;
  label: string;
  schema: SettingDef[];
  split(input: SplitInput, settings: S, ctx: StageContext): Promise<CoverageSet>;
}
