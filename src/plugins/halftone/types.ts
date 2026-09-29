// Every halftone type implements this interface. One type is chosen for the
// whole image; per-ink settings (cell size, angle, dot size…) let each layer
// get its own halftone. Layers are placed independently.
//
// A method contributes GLSL instead of rendering a texture, so the display can
// evaluate the halftone at exact output resolution for whatever part of the
// image is on screen (many samples per screen pixel when zoomed out, averaged
// in linear light; a few when zoomed in). Export uses the same code at full
// resolution. The GLSL must define:
//
//   // Output-pixel position whose coverage decides the dot containing p
//   // (e.g. the center of p's halftone cell).
//   vec2 htSamplePoint(int ink, vec2 p);
//   // Given that coverage c (0..1), is point p inked? Returns 0 or 1.
//   float htInk(int ink, vec2 p, float c);
//
// p is in output pixels (the export's pixel grid). Uniform names should be
// unique to the method. The method may also call
//
//   float htCoverage(int ink, vec2 p);   // coverage at any output position
//
// e.g. to check neighboring cells.

import type { Gpu, Target, UniformValue } from "../../engine/gl/gpu";
import type { SectionSchema, SectionValues } from "../../schema/types";

export interface HalftoneContext {
  gpu: Gpu;
  inkCount: number;
  /** Shared minimum dot size per ink, in output pixels. */
  minDot: number[];
  /** Tones lighter than the minimum dot: drop to paper, or round up to the minimum dot. */
  minDotMode: "drop" | "round";
  /**
   * Whole-image analysis of the adjusted image (luminance, gradient), computed
   * once on first request and shared by every ink layer. None of the basic
   * types need it; structure-aware types will.
   */
  analysis(): Target;
}

export interface HalftoneMethod<Sec extends SectionSchema = SectionSchema, P = unknown> {
  id: string;
  label: string;
  /** Settings section, with parent "halftone". */
  section: Sec;
  glsl: string;
  /** Optional heavy CPU work (e.g. a threshold map), cached by the key it returns. */
  prepareKey?(values: SectionValues<Sec>): string;
  prepare?(values: SectionValues<Sec>): Promise<P>;
  uniforms(values: SectionValues<Sec>, ctx: HalftoneContext, prepared: P | undefined): Record<string, UniformValue>;
}

export function defineHalftoneMethod<Sec extends SectionSchema, P>(method: HalftoneMethod<Sec, P>): HalftoneMethod<Sec, P> {
  return method;
}
