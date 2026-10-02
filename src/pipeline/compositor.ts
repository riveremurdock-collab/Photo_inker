// Halftone compositor: draws the inked, halftoned image straight into the
// preview canvas for the current view.
//
// Each screen pixel takes a grid of jittered samples across its footprint. At
// every sample, each ink's halftone decides (at exact output resolution)
// whether that point is inked; the resulting ink combination is a lookup in the
// spectral overlap table. The samples are averaged in linear light, so
// zoomed-out views show the true average tone of the dots (not a blurred or
// aliased version), and zoomed-in views show crisp, anti-aliased dots.

import { GLSL_FRAME, GLSL_ROUNDED_RECT } from "../app/border";
import { glslPrintSim } from "../app/printSim";
import { BAND_MS, bandRows, timedBand } from "../engine/gl/bands";
import type { Gpu, Target, UniformValue } from "../engine/gl/gpu";
import { GLSL_INKS } from "../engine/gl/inkShader";
import { GLSL_LINEAR_TO_SRGB, GLSL_SRGB_TO_LINEAR } from "../engine/gl/program";
import type { HalftoneMethod } from "../plugins/halftone/types";
import type { ProceduralSource, ViewTransform } from "../ui/preview/viewRenderer";

/** Samples per axis per screen pixel (so up to 64 samples) once the view has settled. */
const MAX_SAMPLES = 8;
/** Samples per axis while zooming/panning. */
const FAST_SAMPLES = 3;
/**
 * GPU time per animation frame before the rest of the view is left for the
 * next frame (heavy halftones then fill in from the top, keeping the page responsive).
 */
const FRAME_MS = 2 * BAND_MS;

function fragment(methodGlsl: string, simEffects: boolean): string {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCoverage;  // ink coverage after layer options (working resolution)
uniform sampler2D uImage;     // working image, for transparency
uniform vec2 uViewSize;
uniform vec2 uOrigin;
uniform float uScale;         // device px per image px
uniform vec2 uImageSize;      // image px
uniform float uOutScale;      // output px per image px
uniform int uSamples;         // per axis
uniform vec4 uVisible;        // solo/mute
uniform vec3 uBackground;     // linear, around the image
out vec4 outColor;
${GLSL_SRGB_TO_LINEAR}
${GLSL_INKS}
${GLSL_LINEAR_TO_SRGB}
${GLSL_ROUNDED_RECT}
${GLSL_FRAME}

float htCoverageRaw(int ink, vec2 p) {
  vec2 uv = clamp(p / uOutScale / uImageSize, vec2(0.0), vec2(1.0));
  return textureLod(uCoverage, uv, 0.0)[ink] * textureLod(uImage, uv, 0.0).a;
}
${glslPrintSim(simEffects)}
// Coverage of an ink at output position p (with the image's transparency, and
// dot gain / compensation). Halftone code may call it.
float htCoverage(int ink, vec2 p) { return simTone(ink, htCoverageRaw(ink, p)); }

${methodGlsl}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uViewSize.y - gl_FragCoord.y);
  vec2 center = (p - uOrigin) / uScale;  // image px
  float footprint = 1.0 / uScale;        // one screen pixel, in image px
  vec2 jitter = vec2(hash(p), hash(p + 17.31));
  vec3 sum = vec3(0.0);
  float count = 0.0;
  // Low-ink patches vary slowly: one lookup per ink per screen pixel.
  float lost[4];
  for (int ink = 0; ink < 4; ink++) lost[ink] = simPatchLost(ink, simWarp(ink, center * uOutScale, false));
  for (int j = 0; j < ${MAX_SAMPLES}; j++) {
    if (j >= uSamples) break;
    for (int i = 0; i < ${MAX_SAMPLES}; i++) {
      if (i >= uSamples) break;
      // Stratified, jittered samples: no regular grid to alias against the dot grid.
      vec2 cell = vec2(float(i), float(j));
      vec2 f = (cell + fract(jitter + cell * vec2(0.618034, 0.754878))) / float(uSamples) - 0.5;
      vec2 ip = center + f * footprint;
      count += 1.0;
      // Outside the canvas (the image, plus a border that grows it): preview background.
      if (frameOutsideCanvas(ip)) {
        sum += uBackground;
        continue;
      }
      vec2 op = ip * uOutScale;  // output px
      int mask = 0;
      for (int ink = 0; ink < 4; ink++) {
        if (ink >= uInkCount) break;
        if (uVisible[ink] < 0.5) continue;
        // Each ink is read at its own (misregistered) position; its border moves with it.
        vec2 q = simWarp(ink, op, true);
        vec2 iq = q / uOutScale;
        bool on;
        if (frameCovers(iq)) on = frameMask() == (1 << ink);
        else if (any(lessThan(iq, vec2(0.0))) || any(greaterThanEqual(iq, uImageSize))) on = false;
        else on = htInk(ink, q, htCoverage(ink, htSamplePoint(ink, q))) > 0.5;
        if (simApply(ink, q, lost[ink], on)) mask |= (1 << ink);
      }
      sum += uTable[mask];
    }
  }
  outColor = vec4(linearToSrgb(gamutCompress(sum / count)), 1.0);
}
`;
}

export interface CompositorState {
  method: HalftoneMethod;
  methodUniforms: Record<string, UniformValue>;
  inkUniforms: Record<string, UniformValue>;
  coverage: Target;
  image: Target;
  imageWidth: number;
  imageHeight: number;
  outputScale: number;
  visible: number[];
  background: [number, number, number];
}

export class Compositor implements ProceduralSource {
  readonly kind = "procedural";
  private state: CompositorState | null = null;
  private shaders = new Map<string, string>();
  private frame: Record<string, UniformValue> = {};
  private sim: Record<string, UniformValue> = {};
  /** Rows of the canvas drawn so far for the current view (from the top). */
  private rowsDone = 0;

  constructor(private gpu: Gpu) {}

  set(state: CompositorState): void {
    this.state = state;
  }

  /** Print simulation uniforms (see app/printSim.ts). */
  setSim(sim: Record<string, UniformValue>): void {
    this.sim = sim;
  }

  /** Solid ink / paper border uniforms (see app/border.ts). */
  setFrame(frame: Record<string, UniformValue>): void {
    this.frame = frame;
  }

  /** Samples per axis: enough to cover every output pixel under a screen pixel, within limits. */
  static samplesFor(outputPxPerScreenPx: number, quality: "fast" | "full"): number {
    const full = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(outputPxPerScreenPx * 1.5)));
    return quality === "fast" ? Math.min(full, FAST_SAMPLES) : full;
  }

  /**
   * Draws the view top-down in bands (see engine/gl/bands.ts), for up to about
   * FRAME_MS. Returns false if rows are left: call again with restart = false
   * on the next frame to continue where it stopped.
   */
  draw(view: ViewTransform, canvasWidth: number, canvasHeight: number, quality: "fast" | "full", restart: boolean): boolean {
    const s = this.state;
    if (!s) return true;
    if (restart) this.rowsDone = 0;
    const simEffects = this.sim.uSimOn === 1;
    const key = `${s.method.id}|${simEffects}`;
    let shader = this.shaders.get(key);
    if (!shader) this.shaders.set(key, (shader = fragment(s.method.glsl, simEffects)));
    const samples = Compositor.samplesFor(s.outputScale / view.scale, quality);
    const uniforms: Record<string, UniformValue> = {
      ...s.inkUniforms,
      ...s.methodUniforms,
      uFrameCanvas: [0, 0, s.imageWidth, s.imageHeight],
      uFrameMode: 0,
      ...this.frame,
      ...this.sim,
      uCoverage: { texture: s.coverage.texture },
      uImage: { texture: s.image.texture },
      uViewSize: [canvasWidth, canvasHeight],
      uOrigin: [view.originX, view.originY],
      uScale: view.scale,
      uImageSize: [s.imageWidth, s.imageHeight],
      uOutScale: s.outputScale,
      uSamples: samples,
      uVisible: s.visible,
      uBackground: s.background,
    };
    const costKey = `preview|${key}|${samples}`;
    const start = performance.now();
    while (this.rowsDone < canvasHeight) {
      if (this.rowsDone > 0 && performance.now() - start > FRAME_MS) return false;
      const rows = bandRows(costKey, canvasWidth, canvasHeight - this.rowsDone);
      // GL rows count from the bottom; bands go from the top of the canvas down.
      const band = { y: canvasHeight - this.rowsDone - rows, height: rows };
      timedBand(this.gpu, null, costKey, canvasWidth * rows, () => this.gpu.draw(shader, null, canvasWidth, canvasHeight, uniforms, band));
      this.rowsDone += rows;
    }
    return true;
  }
}
