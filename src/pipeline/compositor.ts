// Halftone compositor: draws the inked, halftoned image straight into the
// preview canvas for the current view.
//
// Each screen pixel takes a grid of jittered samples across its footprint. At
// every sample, each ink's halftone decides (at exact output resolution)
// whether that point is inked; the resulting ink combination is a lookup in the
// spectral overlap table. The samples are averaged in linear light, so
// zoomed-out views show the true average tone of the dots (not a blurred or
// aliased version), and zoomed-in views show crisp, anti-aliased dots.

import type { Gpu, Target, UniformValue } from "../engine/gl/gpu";
import { GLSL_INKS } from "../engine/gl/inkShader";
import { GLSL_LINEAR_TO_SRGB, GLSL_SRGB_TO_LINEAR } from "../engine/gl/program";
import type { HalftoneMethod } from "../plugins/halftone/types";
import type { ProceduralSource, ViewTransform } from "../ui/preview/viewRenderer";

/** Samples per axis per screen pixel (so up to 64 samples) once the view has settled. */
const MAX_SAMPLES = 8;
/** Samples per axis while zooming/panning. */
const FAST_SAMPLES = 3;

function fragment(methodGlsl: string): string {
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

// Coverage of an ink at output position p (with the image's transparency). Halftone code may call it.
float htCoverage(int ink, vec2 p) {
  vec2 uv = clamp(p / uOutScale / uImageSize, vec2(0.0), vec2(1.0));
  return textureLod(uCoverage, uv, 0.0)[ink] * textureLod(uImage, uv, 0.0).a;
}

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
  for (int j = 0; j < ${MAX_SAMPLES}; j++) {
    if (j >= uSamples) break;
    for (int i = 0; i < ${MAX_SAMPLES}; i++) {
      if (i >= uSamples) break;
      // Stratified, jittered samples: no regular grid to alias against the dot grid.
      vec2 cell = vec2(float(i), float(j));
      vec2 f = (cell + fract(jitter + cell * vec2(0.618034, 0.754878))) / float(uSamples) - 0.5;
      vec2 ip = center + f * footprint;
      count += 1.0;
      if (any(lessThan(ip, vec2(0.0))) || any(greaterThanEqual(ip, uImageSize))) {
        sum += uBackground;
        continue;
      }
      vec2 op = ip * uOutScale;  // output px
      int mask = 0;
      for (int ink = 0; ink < 4; ink++) {
        if (ink >= uInkCount) break;
        if (uVisible[ink] < 0.5) continue;
        float c = htCoverage(ink, htSamplePoint(ink, op));
        if (htInk(ink, op, c) > 0.5) mask |= (1 << ink);
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

  constructor(private gpu: Gpu) {}

  set(state: CompositorState): void {
    this.state = state;
  }

  /** Samples per axis: enough to cover every output pixel under a screen pixel, within limits. */
  static samplesFor(outputPxPerScreenPx: number, quality: "fast" | "full"): number {
    const full = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(outputPxPerScreenPx * 1.5)));
    return quality === "fast" ? Math.min(full, FAST_SAMPLES) : full;
  }

  draw(view: ViewTransform, canvasWidth: number, canvasHeight: number, quality: "fast" | "full"): void {
    const s = this.state;
    if (!s) return;
    let shader = this.shaders.get(s.method.id);
    if (!shader) this.shaders.set(s.method.id, (shader = fragment(s.method.glsl)));
    this.gpu.draw(shader, null, canvasWidth, canvasHeight, {
      ...s.inkUniforms,
      ...s.methodUniforms,
      uCoverage: { texture: s.coverage.texture },
      uImage: { texture: s.image.texture },
      uViewSize: [canvasWidth, canvasHeight],
      uOrigin: [view.originX, view.originY],
      uScale: view.scale,
      uImageSize: [s.imageWidth, s.imageHeight],
      uOutScale: s.outputScale,
      uSamples: Compositor.samplesFor(s.outputScale / view.scale, quality),
      uVisible: s.visible,
      uBackground: s.background,
    });
  }
}
