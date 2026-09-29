// Channel Split: converts the image to a color space and sends each channel
// to an ink as its density.
//
// Simple routing: each channel picks an ink (or is dropped), with an
// intensity (gain, clipped) and opacity (how much it can contribute). Channels
// sent to the same ink are merged with a blend mode.
// Advanced mixer: each ink = Σ weight × channel + offset, which covers
// routing, merging, dropping, and intensity in one matrix.

import { GLSL_LINEAR_TO_SRGB } from "../../engine/gl/program";
import { MAX_INKS } from "../../pipeline/coverage";
import { defineSection, type SettingDef } from "../../schema/types";
import { defineSplitMethod } from "./types";

/** Most channels any space produces (Lab and YCbCr split into ± halves: 5). */
export const MAX_CHANNELS = 5;

export const SPACES = ["rgb", "cmyk", "lab", "hsl", "ycbcr"] as const;
export type Space = (typeof SPACES)[number];

/** Channel names for a space (split = signed channels as + and − halves). */
export function channelNames(space: string, split: boolean): string[] {
  switch (space) {
    case "rgb":
      return ["Red (inverted)", "Green (inverted)", "Blue (inverted)"];
    case "cmyk":
      return ["Cyan", "Magenta", "Yellow", "Black"];
    case "lab":
      return split ? ["Lightness (inverted)", "a+ (red)", "a− (green)", "b+ (yellow)", "b− (blue)"] : ["Lightness (inverted)", "a", "b"];
    case "hsl":
      return ["Hue", "Saturation", "Lightness (inverted)"];
    default:
      return split ? ["Luma (inverted)", "Cb+ (blue)", "Cb− (yellow)", "Cr+ (red)", "Cr− (green)"] : ["Luma (inverted)", "Cb", "Cr"];
  }
}

const INK_OPTIONS = [
  { value: "none", label: "Dropped" },
  { value: "0", label: "Ink 1" },
  { value: "1", label: "Ink 2" },
  { value: "2", label: "Ink 3" },
  { value: "3", label: "Ink 4" },
] as const;

// Per-channel routing and the mixer matrix are edited in a custom block, so these are hidden.
const channelSettings: SettingDef[] = [];
for (let c = 0; c < MAX_CHANNELS; c++) {
  channelSettings.push(
    { kind: "select", key: `ch${c}Ink`, label: `Channel ${c + 1} ink`, default: c < MAX_INKS ? String(c) : "none", options: INK_OPTIONS, hidden: true },
    { kind: "number", key: `ch${c}Intensity`, label: `Channel ${c + 1} intensity`, default: 100, min: 0, max: 300, step: 1, hidden: true },
    { kind: "number", key: `ch${c}Opacity`, label: `Channel ${c + 1} opacity`, default: 100, min: 0, max: 100, step: 1, hidden: true },
  );
}
for (let i = 0; i < MAX_INKS; i++) {
  for (let c = 0; c < MAX_CHANNELS; c++) {
    channelSettings.push({ kind: "number", key: `m${i}_${c}`, label: `Ink ${i + 1} ← channel ${c + 1}`, default: i === c ? 1 : 0, min: -2, max: 2, step: 0.01, hidden: true });
  }
  channelSettings.push({ kind: "number", key: `m${i}_offset`, label: `Ink ${i + 1} offset`, default: 0, min: -1, max: 1, step: 0.01, hidden: true });
}

export const channelSplitSection = defineSection({
  id: "splitChannel",
  title: "Channel Split",
  stage: "split",
  parent: "split",
  description: "Turns each channel of a color space into an ink. Quick full-color approximations, CMY-like ink sets, and experimental color shifts.",
  visibleWhen: (s) => s.split?.method === "channel",
  settings: [
    {
      kind: "select",
      key: "space",
      label: "Color space",
      default: "cmyk",
      options: [
        { value: "rgb", label: "RGB (inverted)" },
        { value: "cmyk", label: "CMYK" },
        { value: "lab", label: "Lab" },
        { value: "hsl", label: "HSL" },
        { value: "ycbcr", label: "YCbCr" },
      ],
    },
    {
      kind: "number",
      key: "blackGeneration",
      label: "Black generation",
      default: 50,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "How much of the dark tones move from C, M, and Y to the black channel.",
      visibleWhen: (s) => s.space === "cmyk",
    },
    {
      kind: "toggle",
      key: "splitSigned",
      label: "Split a/b into + and − halves",
      default: true,
      help: "So one axis can drive two inks, e.g. a+ to a red ink and a− to a green one.",
      visibleWhen: (s) => s.space === "lab" || s.space === "ycbcr",
    },
    {
      kind: "select",
      key: "blend",
      label: "Merging channels into one ink",
      default: "add",
      options: [
        { value: "add", label: "Add" },
        { value: "max", label: "Max" },
        { value: "average", label: "Average" },
        { value: "screen", label: "Screen" },
      ],
      visibleWhen: (s) => !s.advanced,
    },
    { kind: "toggle", key: "advanced", label: "Advanced mixer matrix", default: false, hidden: true },
    ...channelSettings,
  ],
});

export const SPACE_INDEX: Record<string, number> = { rgb: 0, cmyk: 1, lab: 2, hsl: 3, ycbcr: 4 };
const BLEND_INDEX: Record<string, number> = { add: 0, max: 1, average: 2, screen: 3 };

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform vec2 uSize;
uniform int uSpace;
uniform float uBlackGen;
uniform int uSplit;
uniform int uAdvanced;
uniform int uBlend;
uniform float uChInk[${MAX_CHANNELS}];     // target ink per channel (-1 = dropped)
uniform float uChGain[${MAX_CHANNELS}];
uniform float uChOpacity[${MAX_CHANNELS}];
uniform float uMatrix[${MAX_INKS * MAX_CHANNELS}];
uniform vec4 uOffset;
uniform int uInkCount;
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}

float labF(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }

// Channel values 0..1 (signed ones -1..1 before splitting). Unused slots are 0.
void channels(vec3 lin, out float ch[${MAX_CHANNELS}]) {
  for (int i = 0; i < ${MAX_CHANNELS}; i++) ch[i] = 0.0;
  vec3 s = linearToSrgb(lin);
  if (uSpace == 0) {
    ch[0] = 1.0 - s.r; ch[1] = 1.0 - s.g; ch[2] = 1.0 - s.b;
  } else if (uSpace == 1) {
    vec3 cmy = 1.0 - s;
    float k = min(cmy.r, min(cmy.g, cmy.b)) * uBlackGen;
    vec3 c = k < 0.999 ? (cmy - k) / (1.0 - k) : vec3(0.0);
    ch[0] = c.r; ch[1] = c.g; ch[2] = c.b; ch[3] = k;
  } else if (uSpace == 2) {
    vec3 c = clamp(lin, 0.0, 1.0);
    float x = dot(c, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047;
    float y = dot(c, vec3(0.2126729, 0.7151522, 0.072175));
    float z = dot(c, vec3(0.0193339, 0.119192, 0.9503041)) / 1.08883;
    float fx = labF(x), fy = labF(y), fz = labF(z);
    float L = 116.0 * fy - 16.0, a = 500.0 * (fx - fy), b = 200.0 * (fy - fz);
    ch[0] = 1.0 - L / 100.0;
    // a and b reach roughly ±100 for vivid sRGB colors.
    if (uSplit == 1) {
      ch[1] = max(a, 0.0) / 90.0; ch[2] = max(-a, 0.0) / 90.0; ch[3] = max(b, 0.0) / 90.0; ch[4] = max(-b, 0.0) / 90.0;
    } else {
      ch[1] = 0.5 + a / 180.0; ch[2] = 0.5 + b / 180.0;
    }
  } else if (uSpace == 3) {
    float mx = max(s.r, max(s.g, s.b)), mn = min(s.r, min(s.g, s.b));
    float l = (mx + mn) * 0.5, d = mx - mn;
    float sat = d < 1e-5 ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
    float h = 0.0;
    if (d > 1e-5) {
      if (mx == s.r) h = mod((s.g - s.b) / d, 6.0);
      else if (mx == s.g) h = (s.b - s.r) / d + 2.0;
      else h = (s.r - s.g) / d + 4.0;
    }
    ch[0] = h / 6.0; ch[1] = clamp(sat, 0.0, 1.0); ch[2] = 1.0 - l;
  } else {
    float yy = dot(s, vec3(0.299, 0.587, 0.114));
    float cb = (s.b - yy) / 1.772, cr = (s.r - yy) / 1.402;  // -0.5..0.5
    ch[0] = 1.0 - yy;
    if (uSplit == 1) {
      ch[1] = max(cb, 0.0) * 2.0; ch[2] = max(-cb, 0.0) * 2.0; ch[3] = max(cr, 0.0) * 2.0; ch[4] = max(-cr, 0.0) * 2.0;
    } else {
      ch[1] = 0.5 + cb; ch[2] = 0.5 + cr;
    }
  }
}

void main() {
  vec4 t = texture(uImage, gl_FragCoord.xy / uSize);
  float ch[${MAX_CHANNELS}];
  channels(t.rgb, ch);
  vec4 ink = vec4(0.0);
  if (uAdvanced == 1) {
    for (int i = 0; i < ${MAX_INKS}; i++) {
      float v = uOffset[i];
      for (int c = 0; c < ${MAX_CHANNELS}; c++) v += uMatrix[i * ${MAX_CHANNELS} + c] * ch[c];
      ink[i] = v;
    }
  } else {
    vec4 count = vec4(0.0);
    vec4 keep = vec4(1.0); // for screen: product of (1 - v)
    for (int c = 0; c < ${MAX_CHANNELS}; c++) {
      int target = int(uChInk[c]);
      if (target < 0 || target >= ${MAX_INKS}) continue;
      float v = clamp(ch[c] * uChGain[c], 0.0, 1.0) * uChOpacity[c];
      if (uBlend == 1) ink[target] = max(ink[target], v);
      else if (uBlend == 3) keep[target] *= 1.0 - v;
      else ink[target] += v;
      count[target] += 1.0;
    }
    if (uBlend == 2) ink /= max(count, vec4(1.0));
    if (uBlend == 3) ink = 1.0 - keep;
  }
  for (int i = 0; i < ${MAX_INKS}; i++) if (i >= uInkCount) ink[i] = 0.0;
  outColor = clamp(ink, 0.0, 1.0);
}
`;

type Values = Record<string, unknown>;
const num = (v: Values, k: string, d = 0) => (typeof v[k] === "number" ? (v[k] as number) : d);

export const channelSplit = defineSplitMethod({
  id: "channel",
  label: "Channel Split",
  section: channelSplitSection,
  dependsOn: () => null, // channels don't depend on the ink colors
  render(ctx, image, out, values) {
    const v = values as unknown as Values;
    const inks: number[] = [];
    const gains: number[] = [];
    const opacities: number[] = [];
    for (let c = 0; c < MAX_CHANNELS; c++) {
      const target = String(v[`ch${c}Ink`] ?? "none");
      inks.push(target === "none" ? -1 : Number(target));
      gains.push(num(v, `ch${c}Intensity`, 100) / 100);
      opacities.push(num(v, `ch${c}Opacity`, 100) / 100);
    }
    const matrix: number[] = [];
    const offset: number[] = [];
    for (let i = 0; i < MAX_INKS; i++) {
      for (let c = 0; c < MAX_CHANNELS; c++) matrix.push(num(v, `m${i}_${c}`));
      offset.push(num(v, `m${i}_offset`));
    }
    ctx.gpu.pass(FRAGMENT, out, {
      uImage: { texture: image.texture },
      uSize: [out.width, out.height],
      uSpace: SPACE_INDEX[String(v.space)] ?? 1,
      uBlackGen: num(v, "blackGeneration", 50) / 100,
      uSplit: v.splitSigned ? 1 : 0,
      uAdvanced: v.advanced ? 1 : 0,
      uBlend: BLEND_INDEX[String(v.blend)] ?? 0,
      uChInk: inks,
      uChGain: gains,
      uChOpacity: opacities,
      uMatrix: matrix,
      uOffset: offset,
      uInkCount: ctx.inkCount,
    });
  },
});
