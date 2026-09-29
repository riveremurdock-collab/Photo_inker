// Every color splitting method implements this interface: settings schema in,
// ink coverage layers out. Adding a method = one file + one registry line.
//
// A method's settings are a schema section with parent "split", so they show
// inside the Color Splitting panel section when the method is chosen, and are
// stored in the project settings under the section's id.

import type { Gpu, Target } from "../../engine/gl/gpu";
import type { InkSpec, OverlapTable } from "../../engine/spectral/inkModel";
import type { SectionSchema, SectionValues } from "../../schema/types";

export interface SplitContext {
  gpu: Gpu;
  inkCount: number;
  /** In print order. */
  inks: InkSpec[];
  paper: string;
  /** Solid overlap colors from the spectral ink model. */
  table: OverlapTable;
}

export type PrepareQuality = "draft" | "final";

export interface SplitMethod<Sec extends SectionSchema = SectionSchema, P = unknown> {
  id: string;
  label: string;
  /** Settings section (parent "split"); its description is shown under the method picker. */
  section: Sec;
  /**
   * Inputs besides the method's own settings and the adjusted image that the
   * result depends on (part of the cache key). Return null if none: then
   * changing ink colors does not rerun this method.
   */
  dependsOn(ctx: SplitContext, values: SectionValues<Sec>): unknown;
  /**
   * Optional heavy CPU work (run in a worker), cached by settings + dependsOn.
   * The pipeline asks for a quick "draft" first, shows it, then a "final".
   */
  prepare?(values: SectionValues<Sec>, ctx: SplitContext, quality: PrepareQuality): Promise<P>;
  /** GPU pass: adjusted image (linear light) → ink coverage (one ink per channel). */
  render(ctx: SplitContext, image: Target, out: Target, values: SectionValues<Sec>, prepared: P | undefined): void;
}

/** Erases a method's specific types so methods can sit in one list. */
export function defineSplitMethod<Sec extends SectionSchema, P>(method: SplitMethod<Sec, P>): SplitMethod<Sec, P> {
  return method;
}
