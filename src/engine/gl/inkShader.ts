// GLSL for turning ink coverage (one ink per channel of a vec4) into color.
// Used by the test view now and by the image preview and Digital export later,
// so every place that shows inks mixes them the same way.
//
// mixInks(): the solid overlap table (computed on the CPU by the spectral ink
// model) holds the color of every ink combination. A pixel with partial
// coverage is the area-weighted average of those combinations (Demichel
// weights), all in linear light. Converting a spectrum to color is linear, so
// this is exactly the band-by-band spectral mix, just cheaper; and if measured
// ink colors replace the model later, only the table changes.
//
// gamutCompress(): overlaps of vivid inks can land outside sRGB. Instead of
// clipping each channel (which shifts hue), the color is desaturated toward
// its own lightness just enough to fit. Colors already inside sRGB are left
// exactly as they are, so a solid ink shows exactly the color that was picked.

import type { InkSetup } from "../spectral/overlapTable";
import type { OverlapTable } from "../spectral/inkModel";
import { hexToRgb } from "../../util/color";
import { MAX_INKS } from "../../pipeline/coverage";

export const GLSL_INKS = /* glsl */ `
uniform vec3 uTable[16];     // linear RGB of each ink combination (bit i = ink i)
uniform int uInkCount;
uniform vec3 uPaperSrgb;     // for the multiply comparison
uniform vec3 uInkSrgb[4];

vec3 mixInks(vec4 cov) {
  vec3 sum = vec3(0.0);
  int combos = 1 << uInkCount;
  for (int m = 0; m < 16; m++) {
    if (m >= combos) break;
    float w = 1.0;
    for (int i = 0; i < 4; i++) {
      if (i >= uInkCount) break;
      float c = clamp(cov[i], 0.0, 1.0);
      w *= ((m >> i) & 1) == 1 ? c : 1.0 - c;
    }
    sum += w * uTable[m];
  }
  return sum;
}

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

// Simple multiply blend in sRGB, like a layer set to Multiply in an image editor.
// Only used for comparison in the test view.
vec3 multiplyInks(vec4 cov) {
  vec3 c = uPaperSrgb;
  for (int i = 0; i < 4; i++) {
    if (i >= uInkCount) break;
    c *= mix(vec3(1.0), uInkSrgb[i], clamp(cov[i], 0.0, 1.0));
  }
  return srgbToLinear(c);
}

vec3 gamutCompress(vec3 c) {
  float y = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float lo = min(c.r, min(c.g, c.b));
  if (lo < 0.0) c = y + (c - y) * (y / max(y - lo, 1e-6));
  float hi = max(c.r, max(c.g, c.b));
  if (hi > 1.0) c = y + (c - y) * ((1.0 - y) / max(hi - y, 1e-6));
  return clamp(c, 0.0, 1.0);
}
`;

export const INK_UNIFORMS = ["uTable", "uInkCount", "uPaperSrgb", "uInkSrgb"] as const;

/** Uploads the overlap table and ink colors to the currently bound program. */
export function setInkUniforms(
  gl: WebGL2RenderingContext,
  loc: Record<(typeof INK_UNIFORMS)[number], WebGLUniformLocation | null>,
  table: OverlapTable,
  setup: InkSetup,
): void {
  const tableData = new Float32Array(16 * 3);
  tableData.set(table.colors.subarray(0, Math.min(table.colors.length, 48)));
  gl.uniform3fv(loc.uTable, tableData);
  gl.uniform1i(loc.uInkCount, table.inkCount);

  const srgb = (hex: string) => {
    const c = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
    return [c.r / 255, c.g / 255, c.b / 255];
  };
  gl.uniform3fv(loc.uPaperSrgb, srgb(setup.paper));
  const inks = new Float32Array(MAX_INKS * 3);
  setup.inks.forEach((ink, i) => inks.set(srgb(ink.hex), i * 3));
  gl.uniform3fv(loc.uInkSrgb, inks);
}
