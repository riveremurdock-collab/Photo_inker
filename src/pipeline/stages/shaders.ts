// Fragment shaders for the GPU pipeline stages. All textures store row 0 at
// the image top; passes compute uv from gl_FragCoord, so no flipping.

import { GLSL_ROUNDED_RECT } from "../../app/border";
import { glslPrintSim } from "../../app/printSim";
import { GLSL_INKS } from "../../engine/gl/inkShader";
import { GLSL_LIGHTNESS, GLSL_LINEAR_TO_SRGB, GLSL_SRGB_TO_LINEAR } from "../../engine/gl/program";

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uSize;
out vec4 outColor;
`;

/**
 * Copies or downscales an image with an area (box) filter: each output pixel
 * averages a 4×4 grid of samples over its footprint in the source, in linear
 * light. Sharper than a plain mipmap blend for non-power-of-two ratios.
 */
export const COPY = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform vec2 uRatio;   // source texels per output pixel (x, y); 1 = same size
uniform vec4 uRegion;  // part of the source to copy, in source uv: x, y, width, height
void main() {
  vec2 uv = uRegion.xy + gl_FragCoord.xy / uSize * uRegion.zw;
  if (uRatio.x <= 1.0 && uRatio.y <= 1.0) {
    outColor = textureLod(uImage, uv, 0.0);
    return;
  }
  // Each of the 4×4 taps covers ratio/4 source texels; a small LOD keeps every tap
  // averaging its own share of the footprint instead of skipping texels.
  float lod = max(0.0, log2(max(uRatio.x, uRatio.y) / 4.0));
  vec2 tapStep = 1.0 / uSize / 4.0;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 offset = (vec2(float(i), float(j)) - 1.5) * tapStep;
      sum += textureLod(uImage, uv + offset, lod);
    }
  }
  outColor = sum / 16.0;
}
`;

/**
 * Fade border (first, so it is split and halftoned like the rest of the
 * image), then levels + contrast curve (one lookup table, applied to sRGB
 * values) and saturation boost.
 */
export const ADJUST = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform sampler2D uTone;     // 256 × 1: levels then curve, in the red channel
uniform float uSaturation;   // 0 = unchanged
uniform vec4 uRegionPx;      // image px this pass covers: x, y, width, height
uniform int uFade;
uniform vec4 uFadeRect;      // the visible image edge, image px
uniform float uFadeRadius;
uniform float uFadeDistance; // image px
uniform float uFadeColor;    // 0 black, 1 white
uniform float uFadeOpacity;
uniform sampler2D uFadeLut;  // 256 × 1: strength by distance / fade distance
${GLSL_LINEAR_TO_SRGB}
${GLSL_SRGB_TO_LINEAR}
${GLSL_ROUNDED_RECT}
float tone(float v) { return texture(uTone, vec2((v * 255.0 + 0.5) / 256.0, 0.5)).r; }
void main() {
  vec4 t = texture(uImage, gl_FragCoord.xy / uSize);
  vec3 s = linearToSrgb(t.rgb);
  if (uFade == 1) {
    vec2 ip = uRegionPx.xy + gl_FragCoord.xy / uSize * uRegionPx.zw;
    float d = -roundedRectSdf(ip, uFadeRect, uFadeRadius) / uFadeDistance;
    float k = d <= 0.0 ? 1.0 : d >= 1.0 ? 0.0 : texture(uFadeLut, vec2((d * 255.0 + 0.5) / 256.0, 0.5)).r;
    k *= uFadeOpacity;
    // Blended in sRGB, so a linear fade looks even.
    s = mix(s, vec3(uFadeColor), k);
    t.a = mix(t.a, 1.0, k);
  }
  vec3 lin = srgbToLinear(vec3(tone(s.r), tone(s.g), tone(s.b)));
  float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = clamp(y + (lin - y) * (1.0 + uSaturation), 0.0, 1.0);
  outColor = vec4(lin, t.a);
}
`;

/**
 * One direction of an edge-preserving (bilateral) blur. Run horizontally then
 * vertically. Neighbors that differ a lot in color count less, so edges stay sharp.
 */
export const SMOOTH = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform vec2 uDir;      // (1,0) or (0,1)
uniform float uSigma;   // blur radius in pixels
uniform float uRange;   // how different (in sRGB) a neighbor can be and still blend
${GLSL_LINEAR_TO_SRGB}
void main() {
  vec2 px = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * px;
  vec4 center = texture(uImage, uv);
  vec3 cs = linearToSrgb(center.rgb);
  float radius = ceil(uSigma * 2.5);
  float stride = max(1.0, radius / 24.0);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int k = -24; k <= 24; k++) {
    float d = float(k) * stride;
    if (abs(d) > radius) continue;
    vec4 s = texture(uImage, uv + uDir * d * px);
    vec3 diff = linearToSrgb(s.rgb) - cs;
    float w = exp(-(d * d) / (2.0 * uSigma * uSigma) - dot(diff, diff) / (2.0 * uRange * uRange));
    sum += s * w;
    wsum += w;
  }
  outColor = sum / wsum;
}
`;

/** Shared layer options: invert, then density. Channels beyond the ink count are zeroed. */
/**
 * Shared layer options, per pixel:
 * - tone per layer (invert → levels → curve → density), one lookup table per ink channel;
 * - knockout: a knockout layer clears the layers printed before it (lower index) where it has ink;
 * - total ink limit (when there's no trapping pass after this one).
 */
export const LAYERS = /* glsl */ `${HEADER}
uniform sampler2D uCoverage;
uniform sampler2D uTone;     // 256 × 1, one ink per channel
uniform vec4 uActive;
uniform vec4 uKnockout;
uniform float uLimit;        // total ink limit (sum of coverages), e.g. 2.5 = 250%
uniform int uApplyLimit;
float tone(float c, int ink) { return texture(uTone, vec2((clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5))[ink]; }
void main() {
  vec4 c = texture(uCoverage, gl_FragCoord.xy / uSize);
  vec4 t = vec4(tone(c.r, 0), tone(c.g, 1), tone(c.b, 2), tone(c.a, 3)) * uActive;
  // Top layer first, so a layer already cleared by one above it only knocks out where it still prints.
  for (int i = 3; i >= 1; i--) {
    if (uKnockout[i] < 0.5) continue;
    for (int j = 0; j < 4; j++) if (j < i) t[j] *= 1.0 - t[i];
  }
  if (uApplyLimit == 1) {
    float sum = t.r + t.g + t.b + t.a;
    if (sum > uLimit) t *= uLimit / sum;
  }
  outColor = t;
}
`;

/**
 * Choke or spread (trapping), one direction per pass (run horizontally then
 * vertically). Positive radius grows a layer's ink (spread), negative shrinks
 * it (choke). Fractional radii blend in the last pixel, so small traps still show.
 * The second pass can also apply the total ink limit.
 */
export const LAYERS_TRAP = /* glsl */ `${HEADER}
uniform sampler2D uCoverage;
uniform vec2 uDir;
uniform vec4 uRadius;        // texels, per ink
uniform float uLimit;
uniform int uApplyLimit;
void main() {
  vec2 px = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * px;
  vec4 c0 = texture(uCoverage, uv);
  vec4 grow = c0;
  vec4 shrink = c0;
  vec4 r = abs(uRadius);
  float reach = ceil(max(max(r.x, r.y), max(r.z, r.w)));
  for (int k = 1; k <= 24; k++) {
    float d = float(k);
    if (d > reach) break;
    vec4 w = clamp(r - d + 1.0, 0.0, 1.0); // 1 inside the radius, partial at its edge
    vec4 a = mix(c0, texture(uCoverage, uv + uDir * d * px), w);
    vec4 b = mix(c0, texture(uCoverage, uv - uDir * d * px), w);
    grow = max(grow, max(a, b));
    shrink = min(shrink, min(a, b));
  }
  vec4 t = mix(shrink, grow, step(0.0, uRadius));
  if (uApplyLimit == 1) {
    float sum = t.r + t.g + t.b + t.a;
    if (sum > uLimit) t *= uLimit / sum;
  }
  outColor = t;
}
`;

/** Ink coverage → color with the spectral overlap table. Output is linear; the sRGB target encodes it. */
/** Mix pass; simEffects picks the print simulation variant (see app/printSim.ts). */
export const mixShader = (simEffects: boolean) => /* glsl */ `${HEADER}
uniform sampler2D uCoverage;
uniform sampler2D uImage;   // for transparency: transparent pixels get no ink
uniform vec4 uVisible;      // solo/mute: 1 = shown
uniform vec4 uRegionPx;     // image px this pass covers: x, y, width, height
${GLSL_SRGB_TO_LINEAR}
${GLSL_INKS}
${glslPrintSim(simEffects)}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 cov;
  if (${simEffects ? "uSimOn == 0" : "true"}) {
    cov = texture(uCoverage, uv) * texture(uImage, uv).a;
    for (int ink = 0; ink < 4; ink++) cov[ink] = simTone(ink, cov[ink]); // dot gain compensation
  } else {
    // Print simulation on smooth coverage: each ink read at its own misregistered
    // position, then dot gain, low-ink patches (as lost coverage) and specks.
    vec2 op = (uRegionPx.xy + uv * uRegionPx.zw) * uSimOutScale;
    for (int ink = 0; ink < 4; ink++) {
      vec2 q = simWarp(ink, op, false);
      vec2 iq = q / uSimOutScale;
      vec2 quv = (iq - uRegionPx.xy) / uRegionPx.zw;
      float c = 0.0;
      if (all(greaterThanEqual(iq, vec2(0.0))) && all(lessThan(iq, uSimImageSize))) {
        c = simTone(ink, texture(uCoverage, quv)[ink] * texture(uImage, quv).a);
      }
      c *= 1.0 - simPatchLost(ink, q);
      int sp = simSpeck(ink, q);
      if (sp == 1) c = 1.0;
      else if (sp == -1) c = 0.0;
      cov[ink] = c;
    }
  }
  outColor = vec4(gamutCompress(mixInks(cov * uVisible)), 1.0);
}
`;

/** Lightness of each pixel (for the Tone Map histogram), in the red channel. */
export const LIGHTNESS = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform int uSource;
${GLSL_LINEAR_TO_SRGB}
${GLSL_LIGHTNESS}
void main() {
  vec4 t = texture(uImage, gl_FragCoord.xy / uSize);
  outColor = vec4(clamp(lightness(t.rgb, uSource), 0.0, 1.0), 0.0, 0.0, t.a);
}
`;

/**
 * Whole-image analysis shared by every ink layer's halftone: luminance in r,
 * and the luminance gradient (Sobel) in g and b, stored as 0.5 + gradient.
 * Computed only when a halftone type asks for it.
 */
export const ANALYSIS = /* glsl */ `${HEADER}
uniform sampler2D uImage;
float lum(vec2 uv) { return dot(texture(uImage, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 px = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * px;
  float tl = lum(uv + px * vec2(-1.0, -1.0)), t = lum(uv + px * vec2(0.0, -1.0)), tr = lum(uv + px * vec2(1.0, -1.0));
  float l = lum(uv + px * vec2(-1.0, 0.0)), r = lum(uv + px * vec2(1.0, 0.0));
  float bl = lum(uv + px * vec2(-1.0, 1.0)), b = lum(uv + px * vec2(0.0, 1.0)), br = lum(uv + px * vec2(1.0, 1.0));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  outColor = vec4(lum(uv), clamp(0.5 + gx * 0.5, 0.0, 1.0), clamp(0.5 + gy * 0.5, 0.0, 1.0), 1.0);
}
`;
