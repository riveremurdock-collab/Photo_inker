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
  /** Values of any settings section (Detail Split uses it to run its base method). */
  settingsOf(sectionId: string): Record<string, unknown>;
  /** Long edge of the whole image, in image px. */
  imageLongEdge: number;
  /**
   * Texels of the input per image px. Radii given relative to the image stay
   * the same size whether the method runs on the preview's working copy, a
   * zoomed-in detail region, or an export tile.
   */
  texelScale: number;
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
  /** True if prepare() has work to do for these settings (default: prepare exists). */
  needsPrepare?(values: SectionValues<Sec>, ctx: SplitContext): boolean;
  /** GPU pass: adjusted image (linear light) → ink coverage (one ink per channel). */
  render(ctx: SplitContext, image: Target, out: Target, values: SectionValues<Sec>, prepared: P | undefined): void;
  /**
   * How far (in image px) the result at a pixel depends on neighboring pixels,
   * e.g. a blur radius. Tiles and detail regions add this as a margin.
   */
  reach?(values: SectionValues<Sec>, ctx: SplitContext): number;
  /**
   * Optional preview-only view (e.g. a selection mask): when it returns an
   * image, the preview shows that instead of the inks. Never used for export.
   */
  previewOverride?(ctx: SplitContext, image: Target, out: Target, values: SectionValues<Sec>): boolean;
}

/** Keeps a method's specific types while it's being defined. */
export function defineSplitMethod<Sec extends SectionSchema, P>(method: SplitMethod<Sec, P>): SplitMethod<Sec, P> {
  return method;
}
