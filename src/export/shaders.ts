// Export output passes. Each renders one tile of the output pixel grid from a
// region render (coverage at some resolution over a known image-px area).
//
// Mode 0 (Digital): sRGB color. Halftoned tiles use 2×2 jittered samples per
//   pixel, the same as the preview at 100%.
// Mode 1 (Riso layers): one ink per channel, 255 = paper, 0 = ink. Halftoned
//   tiles sample each pixel once, so layers are pure black and white.
//
// Print simulation uniforms come from app/printSim.ts: effects for Digital,
// only dot gain compensation for riso layers.

import { GLSL_FRAME, GLSL_ROUNDED_RECT } from "../app/border";
import { glslPrintSim } from "../app/printSim";
import { GLSL_INKS } from "../engine/gl/inkShader";
import { GLSL_LINEAR_TO_SRGB, GLSL_SRGB_TO_LINEAR } from "../engine/gl/program";

const header = (simEffects: boolean) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCoverage;  // region coverage (after layer options)
uniform sampler2D uImage;     // region image, for transparency
uniform vec2 uTileOrigin;     // output px of this tile's top-left corner, from the image's corner
uniform vec4 uRegion;         // image px covered by the region textures: x, y, w, h
uniform float uOutScale;      // output px per image px
uniform int uMode;            // 0 = digital color, 1 = riso layers
out vec4 outColor;
${GLSL_SRGB_TO_LINEAR}
${GLSL_INKS}
${GLSL_LINEAR_TO_SRGB}
${GLSL_ROUNDED_RECT}
${GLSL_FRAME}

vec2 regionUv(vec2 outputPx) {
  return clamp((outputPx / uOutScale - uRegion.xy) / uRegion.zw, vec2(0.0), vec2(1.0));
}

float htCoverageRaw(int ink, vec2 p) {
  vec2 uv = regionUv(p);
  return textureLod(uCoverage, uv, 0.0)[ink] * textureLod(uImage, uv, 0.0).a;
}
${glslPrintSim(simEffects)}
float htCoverage(int ink, vec2 p) { return simTone(ink, htCoverageRaw(ink, p)); }
`;

/** Halftoned export: the halftone method's GLSL is inserted. */
export function halftoneExportShader(methodGlsl: string, simEffects: boolean): string {
  return /* glsl */ `${header(simEffects)}
${methodGlsl}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

int inkMask(vec2 p) {
  int mask = 0;
  for (int ink = 0; ink < 4; ink++) {
    if (ink >= uInkCount) break;
    // Each ink at its own (misregistered) position; the border moves with its ink.
    vec2 q = simWarp(ink, p, true);
    vec2 iq = q / uOutScale;
    bool on;
    // Solid ink / paper border: over everything, never halftoned.
    if (frameCovers(iq)) on = frameMask() == (1 << ink);
    else if (uSimOn == 1 && (any(lessThan(iq, vec2(0.0))) || any(greaterThanEqual(iq, uSimImageSize)))) on = false;
    else on = htInk(ink, q, htCoverage(ink, htSamplePoint(ink, q))) > 0.5;
    if (simApply(ink, q, simPatchLost(ink, q), on)) mask |= (1 << ink);
  }
  return mask;
}

void main() {
  vec2 p = uTileOrigin + gl_FragCoord.xy; // pixel center, output px (row 0 = top)
  if (uMode == 1) {
    int mask = inkMask(p);
    vec4 gray = vec4(1.0);
    for (int ink = 0; ink < 4; ink++) if ((mask & (1 << ink)) != 0) gray[ink] = 0.0;
    outColor = gray;
    return;
  }
  vec2 jitter = vec2(hash(p), hash(p + 17.31));
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 cell = vec2(float(i), float(j));
      vec2 f = (cell + fract(jitter + cell * vec2(0.618034, 0.754878))) / 2.0 - 0.5;
      sum += uTable[inkMask(p + f)];
    }
  }
  outColor = vec4(linearToSrgb(gamutCompress(sum / 4.0)), 1.0);
}
`;
}

/** Halftone None: smooth coverage (layers) or the mixed color (digital). */
export const smoothExportShader = (simEffects: boolean) => /* glsl */ `${header(simEffects)}
uniform sampler2D uMixed;     // region mixed color (sRGB texture: samples as linear)
void main() {
  vec2 p = uTileOrigin + gl_FragCoord.xy;
  vec2 uv = regionUv(p);
  if (frameCovers(p / uOutScale)) {
    int mask = frameMask();
    if (uMode == 1) {
      vec4 gray = vec4(1.0);
      for (int ink = 0; ink < 4; ink++) if ((mask & (1 << ink)) != 0) gray[ink] = 0.0;
      outColor = gray;
    } else {
      outColor = vec4(linearToSrgb(uTable[mask]), 1.0);
    }
    return;
  }
  if (uMode == 1) {
    vec4 cov = textureLod(uCoverage, uv, 0.0) * textureLod(uImage, uv, 0.0).a;
    vec4 gray = vec4(1.0);
    for (int ink = 0; ink < 4; ink++) if (ink < uInkCount) gray[ink] = 1.0 - simTone(ink, cov[ink]); // compensation
    outColor = gray;
    return;
  }
  outColor = vec4(linearToSrgb(textureLod(uMixed, uv, 0.0).rgb), 1.0);
}
`;
