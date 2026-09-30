// Selective Color: color ranges (hue center and width, saturation and
// lightness limits, feather) each send matching pixels to an ink. Everything
// else can go to a base ink. Membership is soft (feathered), so edges blend.
// A mask preview shows one range's selection in the preview (never exported).

import { GLSL_LINEAR_TO_SRGB } from "../../engine/gl/program";
import { MAX_INKS } from "../../pipeline/coverage";
import { hexToRgb, rgbToLab } from "../../util/color";
import { defineSection, type SettingDef } from "../../schema/types";
import { defineSplitMethod, type SplitContext } from "./types";

export const MAX_RANGES = 6;

const INK_OPTIONS = [
  { value: "0", label: "Ink 1" },
  { value: "1", label: "Ink 2" },
  { value: "2", label: "Ink 3" },
  { value: "3", label: "Ink 4" },
] as const;

/** Per-range settings (edited in the custom block). Keys: r{n}Hue, r{n}Width, … */
export const RANGE_FIELDS = ["Hue", "Width", "SatMin", "SatMax", "LightMin", "LightMax", "Feather", "Ink"] as const;

const rangeSettings: SettingDef[] = [];
for (let r = 0; r < MAX_RANGES; r++) {
  rangeSettings.push(
    { kind: "number", key: `r${r}Hue`, label: "Hue center", default: [0, 120, 240, 60, 180, 300][r]!, min: 0, max: 360, step: 1, unit: "°", hidden: true },
    { kind: "number", key: `r${r}Width`, label: "Hue width", default: 40, min: 2, max: 180, step: 1, unit: "°", hidden: true },
    { kind: "number", key: `r${r}SatMin`, label: "Saturation from", default: 20, min: 0, max: 100, step: 1, unit: "%", hidden: true },
    { kind: "number", key: `r${r}SatMax`, label: "Saturation to", default: 100, min: 0, max: 100, step: 1, unit: "%", hidden: true },
    { kind: "number", key: `r${r}LightMin`, label: "Lightness from", default: 5, min: 0, max: 100, step: 1, unit: "%", hidden: true },
    { kind: "number", key: `r${r}LightMax`, label: "Lightness to", default: 95, min: 0, max: 100, step: 1, unit: "%", hidden: true },
    { kind: "number", key: `r${r}Feather`, label: "Feather", default: 30, min: 0, max: 100, step: 1, unit: "%", hidden: true },
    { kind: "select", key: `r${r}Ink`, label: "Ink", default: String(Math.min(r + 1, MAX_INKS - 1)), options: INK_OPTIONS, hidden: true },
  );
}

export const selectiveColorSection = defineSection({
  id: "splitSelective",
  title: "Selective Color",
  stage: "split",
  parent: "split",
  description: "Pick color ranges and send each to an ink; everything else can go to a base ink. Spot-color accents and one color on a black-and-white image.",
  visibleWhen: (s) => s.split?.method === "selective",
  settings: [
    { kind: "number", key: "rangeCount", label: "Ranges", default: 1, min: 0, max: MAX_RANGES, step: 1, hidden: true },
    { kind: "select", key: "maskPreview", label: "Mask preview", default: "none", hidden: true, options: [{ value: "none", label: "Off" }, ...Array.from({ length: MAX_RANGES }, (_, r) => ({ value: String(r), label: `Range ${r + 1}` }))] },
    ...rangeSettings,
    {
      kind: "select",
      key: "densitySource",
      label: "Ink amount in a range comes from",
      default: "saturation",
      display: "segmented",
      options: [
        { value: "saturation", label: "Saturation" },
        { value: "lightness", label: "Darkness" },
        { value: "constant", label: "Constant" },
      ],
    },
    {
      kind: "select",
      key: "baseInk",
      label: "Base ink (everything else)",
      default: "auto",
      inkChoice: true,
      options: [
        { value: "none", label: "None (paper)" },
        { value: "auto", label: "Auto (darkest ink)" },
        ...INK_OPTIONS,
      ],
      help: "Prints the rest of the image as a grayscale in this ink.",
    },
  ],
});

type Values = Record<string, unknown>;
const num = (v: Values, k: string, d = 0) => (typeof v[k] === "number" ? (v[k] as number) : d);

/** The base ink slot, resolving "auto" to the darkest ink; -1 for none. */
function baseInkSlot(v: Values, ctx: SplitContext): number {
  const choice = String(v.baseInk ?? "auto");
  if (choice === "none") return -1;
  if (choice !== "auto") return Number(choice) < ctx.inkCount ? Number(choice) : -1;
  let best = -1;
  let bestL = Infinity;
  ctx.inks.forEach((ink, i) => {
    const l = rgbToLab(hexToRgb(ink.hex) ?? { r: 0, g: 0, b: 0 }).l;
    if (l < bestL) {
      bestL = l;
      best = i;
    }
  });
  return best;
}

const COMMON = /* glsl */ `
uniform int uRangeCount;
uniform float uHue[${MAX_RANGES}];
uniform float uWidth[${MAX_RANGES}];
uniform vec4 uLimits[${MAX_RANGES}];  // sat min, sat max, light min, light max (0..1)
uniform float uFeather[${MAX_RANGES}]; // 0..1
${GLSL_LINEAR_TO_SRGB}

vec3 hsl(vec3 lin) {
  vec3 s = linearToSrgb(lin);
  float mx = max(s.r, max(s.g, s.b)), mn = min(s.r, min(s.g, s.b));
  float l = (mx + mn) * 0.5, d = mx - mn;
  float sat = d < 1e-5 ? 0.0 : d / max(1e-5, 1.0 - abs(2.0 * l - 1.0));
  float h = 0.0;
  if (d > 1e-5) {
    if (mx == s.r) h = mod((s.g - s.b) / d, 6.0);
    else if (mx == s.g) h = (s.b - s.r) / d + 2.0;
    else h = (s.r - s.g) / d + 4.0;
  }
  return vec3(h * 60.0, clamp(sat, 0.0, 1.0), l);
}

// 1 inside [lo, hi], fading to 0 over 'soft' outside it (hard edge when soft = 0).
float band(float x, float lo, float hi, float soft) {
  if (soft <= 0.0) return (x >= lo && x <= hi) ? 1.0 : 0.0;
  return smoothstep(lo - soft, lo, x) * (1.0 - smoothstep(hi, hi + soft, x));
}

float membership(int r, vec3 c) {
  float f = uFeather[r];
  float dh = abs(mod(c.x - uHue[r] + 180.0, 360.0) - 180.0);
  float halfWidth = uWidth[r] * 0.5;
  float hueW = f <= 0.0 ? (dh <= halfWidth ? 1.0 : 0.0) : 1.0 - smoothstep(halfWidth, halfWidth + f * 60.0, dh);
  vec4 lim = uLimits[r];
  return hueW * band(c.y, lim.x, lim.y, f * 0.25) * band(c.z, lim.z, lim.w, f * 0.25);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform vec2 uSize;
uniform float uInk[${MAX_RANGES}];
uniform int uSource;   // 0 saturation, 1 darkness, 2 constant
uniform int uBase;     // base ink slot or -1
uniform int uInkCount;
out vec4 outColor;
${COMMON}
void main() {
  vec3 c = hsl(texture(uImage, gl_FragCoord.xy / uSize).rgb);
  float amount = uSource == 0 ? c.y : uSource == 1 ? 1.0 - c.z : 1.0;
  vec4 ink = vec4(0.0);
  float selected = 0.0;
  for (int r = 0; r < ${MAX_RANGES}; r++) {
    if (r >= uRangeCount) break;
    float m = membership(r, c);
    selected = max(selected, m);
    int target = int(uInk[r]);
    if (target >= 0 && target < ${MAX_INKS}) ink[target] = max(ink[target], m * amount);
  }
  // Everything else: a grayscale (darkness) in the base ink.
  if (uBase >= 0) ink[uBase] = max(ink[uBase], (1.0 - selected) * (1.0 - c.z));
  for (int i = 0; i < ${MAX_INKS}; i++) if (i >= uInkCount) ink[i] = 0.0;
  outColor = clamp(ink, 0.0, 1.0);
}
`;

/** Mask preview: white where the chosen range selects, black elsewhere (linear output to an sRGB target). */
const MASK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform vec2 uSize;
uniform int uMaskRange;
out vec4 outColor;
${COMMON}
void main() {
  vec4 t = texture(uImage, gl_FragCoord.xy / uSize);
  float m = membership(uMaskRange, hsl(t.rgb));
  outColor = vec4(vec3(m), 1.0);
}
`;

function rangeUniforms(v: Values) {
  const count = Math.min(MAX_RANGES, Math.max(0, num(v, "rangeCount", 1)));
  const hue: number[] = [];
  const width: number[] = [];
  const limits: number[] = [];
  const feather: number[] = [];
  const ink: number[] = [];
  for (let r = 0; r < MAX_RANGES; r++) {
    hue.push(num(v, `r${r}Hue`));
    width.push(num(v, `r${r}Width`, 40));
    limits.push(num(v, `r${r}SatMin`) / 100, num(v, `r${r}SatMax`, 100) / 100, num(v, `r${r}LightMin`) / 100, num(v, `r${r}LightMax`, 100) / 100);
    feather.push(num(v, `r${r}Feather`, 30) / 100);
    ink.push(Number(v[`r${r}Ink`] ?? 0));
  }
  return { uRangeCount: count, uHue: hue, uWidth: width, uLimits: limits, uFeather: feather, uInk: ink };
}

export const selectiveColor = defineSplitMethod({
  id: "selective",
  label: "Selective Color",
  section: selectiveColorSection,
  // Only "auto" base ink depends on the ink colors (which ink is darkest).
  dependsOn: (ctx, values) => baseInkSlot(values as unknown as Values, ctx),
  render(ctx, image, out, values) {
    const v = values as unknown as Values;
    const { uInk, ...ranges } = rangeUniforms(v);
    ctx.gpu.pass(FRAGMENT, out, {
      ...ranges,
      uInk,
      uImage: { texture: image.texture },
      uSize: [out.width, out.height],
      uSource: ({ saturation: 0, lightness: 1, constant: 2 } as Record<string, number>)[String(v.densitySource)] ?? 0,
      uBase: baseInkSlot(v, ctx),
      uInkCount: ctx.inkCount,
    });
  },
  previewOverride(ctx, image, out, values) {
    const v = values as unknown as Values;
    const r = String(v.maskPreview ?? "none");
    if (r === "none" || Number(r) >= num(v, "rangeCount", 1)) return false;
    const { uInk: _ink, ...ranges } = rangeUniforms(v);
    ctx.gpu.pass(MASK_FRAGMENT, out, {
      ...ranges,
      uImage: { texture: image.texture },
      uSize: [out.width, out.height],
      uMaskRange: Number(r),
    });
    return true;
  },
});
