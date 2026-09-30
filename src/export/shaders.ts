// Export output passes. Each renders one tile of the output pixel grid from a
// region render (coverage at some resolution over a known image-px area).
//
// Mode 0 (color: Digital, standard printer, proof): sRGB color. Halftoned
//   tiles average uSamples × uSamples jittered samples per pixel (2 × 2 at
//   full resolution, like the preview at 100%; more for the reduced proof).
// Mode 1 (Riso layers): one ink per channel, 255 = paper, 0 = ink. Halftoned
//   tiles sample each pixel once, so layers are pure black and white.
//
// Output pixels may be larger than halftone output px (uPixel, for the proof).
// Outside the artwork (page margins) pixels get uOutside. With uTransparent,
// paper becomes transparent and ink keeps its printed color.
//
// Print simulation uniforms come from app/printSim.ts.

import { GLSL_FRAME, GLSL_ROUNDED_RECT } from "../app/border";
import { glslPrintSim } from "../app/printSim";
import { GLSL_INKS } from "../engine/gl/inkShader";
import { GLSL_LINEAR_TO_SRGB, GLSL_SRGB_TO_LINEAR } from "../engine/gl/program";

const header = (simEffects: boolean) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCoverage;  // region coverage (after layer options)
uniform sampler2D uImage;     // region image, for transparency
uniform vec2 uTileOrigin;     // this tile's top-left corner in output pixels, from the image's corner
uniform float uPixel;         // halftone output px per output pixel (1, or more for the proof)
uniform int uSamples;         // per axis, color mode
uniform vec4 uRegion;         // image px covered by the region textures: x, y, w, h
uniform float uOutScale;      // halftone output px per image px
uniform int uMode;            // 0 = color, 1 = riso layers
uniform vec4 uOutside;        // written outside the artwork
uniform int uTransparent;
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

vec4 layersOf(int mask) {
  vec4 gray = vec4(1.0);
  for (int ink = 0; ink < 4; ink++) if ((mask & (1 << ink)) != 0) gray[ink] = 0.0;
  return gray;
}
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
  vec2 p = (uTileOrigin + gl_FragCoord.xy) * uPixel; // pixel center, output px (row 0 = top)
  if (frameOutsideCanvas(p / uOutScale)) {
    outColor = uOutside;
    return;
  }
  if (uMode == 1) {
    outColor = layersOf(inkMask(p));
    return;
  }
  vec2 jitter = vec2(hash(p), hash(p + 17.31));
  vec3 sum = vec3(0.0);
  vec3 inkSum = vec3(0.0);
  float inked = 0.0;
  float n = float(uSamples);
  for (int j = 0; j < 8; j++) {
    if (j >= uSamples) break;
    for (int i = 0; i < 8; i++) {
      if (i >= uSamples) break;
      vec2 cell = vec2(float(i), float(j));
      vec2 f = ((cell + fract(jitter + cell * vec2(0.618034, 0.754878))) / n - 0.5) * uPixel;
      int m = inkMask(p + f);
      sum += uTable[m];
      if (m != 0) {
        inkSum += uTable[m];
        inked += 1.0;
      }
    }
  }
  if (uTransparent == 1) {
    // Paper samples are transparent; inked samples keep their color.
    outColor = inked > 0.0 ? vec4(linearToSrgb(gamutCompress(inkSum / inked)), inked / (n * n)) : vec4(0.0);
    return;
  }
  outColor = vec4(linearToSrgb(gamutCompress(sum / (n * n))), 1.0);
}
`;
}

/** Halftone None: smooth coverage (layers) or the mixed color. */
export const smoothExportShader = (simEffects: boolean) => /* glsl */ `${header(simEffects)}
uniform sampler2D uMixed;     // region mixed color (sRGB texture: samples as linear)
void main() {
  vec2 p = (uTileOrigin + gl_FragCoord.xy) * uPixel;
  if (frameOutsideCanvas(p / uOutScale)) {
    outColor = uOutside;
    return;
  }
  vec2 uv = regionUv(p);
  if (frameCovers(p / uOutScale)) {
    int mask = frameMask();
    if (uMode == 1) outColor = layersOf(mask);
    else if (uTransparent == 1 && mask == 0) outColor = vec4(0.0);
    else outColor = vec4(linearToSrgb(uTable[mask]), 1.0);
    return;
  }
  vec4 cov = textureLod(uCoverage, uv, 0.0) * textureLod(uImage, uv, 0.0).a;
  for (int ink = 0; ink < 4; ink++) cov[ink] = ink < uInkCount ? simTone(ink, cov[ink]) : 0.0; // compensation
  if (uMode == 1) {
    outColor = vec4(1.0) - cov;
    return;
  }
  vec3 mixed = textureLod(uMixed, uv, 0.0).rgb;
  if (uTransparent == 1) {
    // Share of the pixel with any ink (inks overlap independently), and the
    // ink color with the paper taken back out of the mix.
    float bare = (1.0 - cov.r) * (1.0 - cov.g) * (1.0 - cov.b) * (1.0 - cov.a);
    float a = 1.0 - bare;
    outColor = a > 0.002 ? vec4(linearToSrgb(clamp((mixed - bare * uTable[0]) / a, 0.0, 1.0)), a) : vec4(0.0);
    return;
  }
  outColor = vec4(linearToSrgb(mixed), 1.0);
}
`;
