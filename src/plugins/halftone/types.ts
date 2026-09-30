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
//
// Types that can't be evaluated point by point (error diffusion, where each
// pixel depends on the ones before it) provide `fromCoverage`: they get the
// whole image's coverage on a grid, build a bitmap (in a worker), and their
// GLSL reads that bitmap.

import type { Gpu, Target, UniformValue } from "../../engine/gl/gpu";
import type { SectionSchema, SectionValues } from "../../schema/types";

export interface HalftoneContext {
  gpu: Gpu;
  inkCount: number;
  /** Shared minimum dot size per ink, in output pixels. */
  minDot: number[];
  /** Tones lighter than the minimum dot: drop to paper, or round up to the minimum dot. */
  minDotMode: "drop" | "round";
  /** Size of the output pixel grid. */
  outputWidth: number;
  outputHeight: number;
  /**
   * Whole-image analysis of the adjusted image (luminance, gradient), computed
   * once on first request and shared by every ink layer. None of the current
   * types need it; structure-aware types will.
   */
  analysis(): Target;
}

export interface OutputInfo {
  outputWidth: number;
  outputHeight: number;
}

/** A bitmap built from the whole image's coverage (see fromCoverage). */
export interface CoverageBitmap {
  /** RGBA, one ink per channel: 255 = ink. Row 0 = top. */
  bits: Uint8Array;
  width: number;
  height: number;
  /** Output px per bitmap cell. */
  cell: number;
}

export interface HalftoneMethod<Sec extends SectionSchema = SectionSchema, P = unknown> {
  id: string;
  label: string;
  /** Settings section, with parent "halftone". */
  section: Sec;
  glsl: string;
  /** How far (output px) a dot can reach from its center, if more than the default (1.5 × cell or dot size). */
  reach?(values: SectionValues<Sec>, ctx: HalftoneContext): number;
  /** Optional heavy CPU work (e.g. a threshold map), cached by the key it returns. */
  prepareKey?(values: SectionValues<Sec>, info: OutputInfo): string;
  prepare?(values: SectionValues<Sec>, info: OutputInfo): Promise<P>;
  /**
   * For types built from the whole image (error diffusion): the output px per
   * bitmap cell, and how to build the bitmap from coverage (RGBA bytes, one ink
   * per channel) on a grid of that size.
   */
  fromCoverage?: {
    cell(values: SectionValues<Sec>, ctx: HalftoneContext): number;
    build(
      values: SectionValues<Sec>,
      coverage: Uint8Array,
      width: number,
      height: number,
      inkCount: number,
      purpose: "preview" | "export",
    ): Promise<Uint8Array>;
  };
  uniforms(
    values: SectionValues<Sec>,
    ctx: HalftoneContext,
    prepared: P | undefined,
    bitmap?: CoverageBitmap,
  ): Record<string, UniformValue>;
}

export function defineHalftoneMethod<Sec extends SectionSchema, P>(method: HalftoneMethod<Sec, P>): HalftoneMethod<Sec, P> {
  return method;
}
