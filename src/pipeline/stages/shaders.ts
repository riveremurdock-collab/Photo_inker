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

/** Copies/downscales an image. The source has mipmaps, so a smaller target averages in linear light. */
export const COPY = /* glsl */ `${HEADER}
uniform sampler2D uImage;
void main() {
  outColor = texture(uImage, gl_FragCoord.xy / uSize);
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
