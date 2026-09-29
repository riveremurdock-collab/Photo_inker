// Fragment shaders for the GPU pipeline stages. All textures store row 0 at
// the image top; passes compute uv from gl_FragCoord, so no flipping.

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

/** Levels + contrast curve (one lookup table, applied to sRGB values) and saturation boost. */
export const ADJUST = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform sampler2D uTone;     // 256 × 1: levels then curve, in the red channel
uniform float uSaturation;   // 0 = unchanged
${GLSL_LINEAR_TO_SRGB}
${GLSL_SRGB_TO_LINEAR}
float tone(float v) { return texture(uTone, vec2((v * 255.0 + 0.5) / 256.0, 0.5)).r; }
void main() {
  vec4 t = texture(uImage, gl_FragCoord.xy / uSize);
  vec3 s = linearToSrgb(t.rgb);
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
export const LAYERS = /* glsl */ `${HEADER}
uniform sampler2D uCoverage;
uniform vec4 uDensity;
uniform vec4 uInvert;
uniform vec4 uActive;
void main() {
  vec4 cov = texture(uCoverage, gl_FragCoord.xy / uSize);
  cov = mix(cov, 1.0 - cov, uInvert);
  outColor = clamp(cov * uDensity, 0.0, 1.0) * uActive;
}
`;

/** Ink coverage → color with the spectral overlap table. Output is linear; the sRGB target encodes it. */
export const MIX = /* glsl */ `${HEADER}
uniform sampler2D uCoverage;
uniform sampler2D uImage;   // for transparency: transparent pixels get no ink
uniform vec4 uVisible;      // solo/mute: 1 = shown
${GLSL_SRGB_TO_LINEAR}
${GLSL_INKS}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 cov = texture(uCoverage, uv) * uVisible * texture(uImage, uv).a;
  outColor = vec4(gamutCompress(mixInks(cov)), 1.0);
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
