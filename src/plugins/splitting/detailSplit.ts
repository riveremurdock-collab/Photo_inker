// Detail Split: separates the image into fine detail (edges and texture) and
// a blurred base. The base is split by another method (with that method's own
// settings); the detail goes to one ink, usually the darkest, so the image
// stays sharp even when drums misregister.

import type { Gpu, Target } from "../../engine/gl/gpu";
import { GLSL_LINEAR_TO_SRGB } from "../../engine/gl/program";
import { MAX_INKS } from "../../pipeline/coverage";
import { SMOOTH } from "../../pipeline/stages/shaders";
import { hexToRgb, rgbToLab } from "../../util/color";
import { defineSection } from "../../schema/types";
import { splitMethod } from "./registry";
import { defineSplitMethod, type SplitContext, type SplitMethod } from "./types";

export const detailSplitSection = defineSection({
  id: "splitDetail",
  title: "Detail Split",
  stage: "split",
  parent: "split",
  description: "Fine detail goes to one ink; a blurred base is split by another method. Keeps images sharp despite misregistration.",
  visibleWhen: (s) => s.split?.method === "detail",
  settings: [
    {
      kind: "select",
      key: "baseMethod",
      label: "Method for the base",
      default: "inkMatching",
      options: [
        { value: "inkMatching", label: "Ink Matching" },
        { value: "toneMap", label: "Tone Map" },
        { value: "channel", label: "Channel Split" },
        { value: "selective", label: "Selective Color" },
      ],
      help: "Uses that method's own settings (choose it as the method above to adjust them).",
    },
    {
      kind: "number",
      key: "radius",
      label: "Split radius",
      default: 3,
      min: 0.5,
      max: 30,
      step: 0.5,
      help: "What counts as detail: features smaller than this go to the detail ink. Measured in thousandths of the image's long edge.",
    },
    {
      kind: "select",
      key: "detailMode",
      label: "Detail",
      default: "highpass",
      display: "segmented",
      options: [
        { value: "highpass", label: "High-pass" },
        { value: "lineart", label: "Line art" },
        { value: "edges", label: "Edges" },
      ],
    },
    { kind: "number", key: "contrast", label: "Detail contrast", default: 150, min: 0, max: 400, step: 5, unit: "%" },
    { kind: "number", key: "threshold", label: "Detail threshold", default: 5, min: 0, max: 100, step: 1, unit: "%" },
    {
      kind: "select",
      key: "detailInk",
      label: "Detail ink",
      default: "auto",
      inkChoice: true,
      options: [
        { value: "auto", label: "Auto (darkest ink)" },
        { value: "0", label: "Ink 1" },
        { value: "1", label: "Ink 2" },
        { value: "2", label: "Ink 3" },
        { value: "3", label: "Ink 4" },
      ],
    },
  ],
});

type Values = Record<string, unknown>;
const num = (v: Values, k: string, d = 0) => (typeof v[k] === "number" ? (v[k] as number) : d);

function base(v: Values): SplitMethod {
  const id = String(v.baseMethod ?? "inkMatching");
  return splitMethod(id === "detail" ? "inkMatching" : id);
}
const baseValues = (v: Values, ctx: SplitContext) => ctx.settingsOf(base(v).section.id) as never;

function detailInkSlot(v: Values, ctx: SplitContext): number {
  const choice = String(v.detailInk ?? "auto");
  if (choice !== "auto") return Math.min(Number(choice), ctx.inkCount - 1);
  let best = 0;
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

/** Blur sigma in image px. */
const sigmaImage = (v: Values, ctx: SplitContext) => (num(v, "radius", 3) * ctx.imageLongEdge) / 1000;

const DETAIL = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;    // sharp
uniform sampler2D uBlurred;
uniform sampler2D uBase;     // base coverage (from the base method, on the blurred image)
uniform vec2 uSize;
uniform int uMode;           // 0 high-pass, 1 line art, 2 edges
uniform float uContrast;
uniform float uThreshold;
uniform int uDetailInk;
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}
float luma(vec2 uv) { return dot(linearToSrgb(texture(uImage, uv).rgb), vec3(0.2126, 0.7152, 0.0722)); }
float lumaBlur(vec2 uv) { return dot(linearToSrgb(texture(uBlurred, uv).rgb), vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 px = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * px;
  float d;
  if (uMode == 2) {
    float tl = luma(uv + px * vec2(-1, -1)), t = luma(uv + px * vec2(0, -1)), tr = luma(uv + px * vec2(1, -1));
    float l = luma(uv + px * vec2(-1, 0)), r = luma(uv + px * vec2(1, 0));
    float bl = luma(uv + px * vec2(-1, 1)), b = luma(uv + px * vec2(0, 1)), br = luma(uv + px * vec2(1, 1));
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    d = length(vec2(gx, gy)) * uContrast * 2.0 - uThreshold;
  } else {
    // Darker than the blurred surroundings = detail ink.
    float diff = (lumaBlur(uv) - luma(uv)) * uContrast * 8.0;
    d = uMode == 1 ? smoothstep(uThreshold, uThreshold + 0.06, diff) : diff - uThreshold;
  }
  d = clamp(d, 0.0, 1.0);
  vec4 cov = texture(uBase, uv);
  // Combine with whatever the base put in the detail ink (screen: both show).
  cov[uDetailInk] = 1.0 - (1.0 - cov[uDetailInk]) * (1.0 - d);
  outColor = cov;
}
`;

const temps = new WeakMap<Gpu, { blurA: Target | null; blurB: Target | null; base: Target | null }>();

export const detailSplit = defineSplitMethod({
  id: "detail",
  label: "Detail Split",
  section: detailSplitSection,
  dependsOn(ctx, values) {
    const v = values as unknown as Values;
    const b = base(v);
    const bv = baseValues(v, ctx);
    return { base: b.id, values: bv, dependency: b.dependsOn(ctx, bv), detailInk: detailInkSlot(v, ctx) };
  },
  needsPrepare(values, ctx) {
    const b = base(values as unknown as Values);
    return !!b.prepare && (b.needsPrepare?.(baseValues(values as unknown as Values, ctx), ctx) ?? true);
  },
  prepare(values, ctx, quality) {
    const b = base(values as unknown as Values);
    return b.prepare!(baseValues(values as unknown as Values, ctx), ctx, quality);
  },
  reach(values, ctx) {
    const v = values as unknown as Values;
    const b = base(v);
    return sigmaImage(v, ctx) * 2.5 + (b.reach ? b.reach(baseValues(v, ctx), ctx) : 0) + 2;
  },
  render(ctx, image, out, values, prepared) {
    const v = values as unknown as Values;
    const gpu = ctx.gpu;
    let t = temps.get(gpu);
    if (!t) temps.set(gpu, (t = { blurA: null, blurB: null, base: null }));
    const { width: w, height: h } = image;
    t.blurA = gpu.ensureTarget(t.blurA, w, h, "image");
    t.blurB = gpu.ensureTarget(t.blurB, w, h, "image");
    t.base = gpu.ensureTarget(t.base, w, h, "coverage");

    // Gaussian blur: the smoothing shader with a huge color range ignores edges.
    const sigma = Math.max(0.5, sigmaImage(v, ctx) * ctx.texelScale);
    const common = { uSigma: sigma, uRange: 100, uSize: [w, h] };
    gpu.pass(SMOOTH, t.blurA, { ...common, uImage: { texture: image.texture }, uDir: [1, 0] });
    gpu.pass(SMOOTH, t.blurB, { ...common, uImage: { texture: t.blurA.texture }, uDir: [0, 1] });

    base(v).render(ctx, t.blurB, t.base, baseValues(v, ctx), prepared as never);

    gpu.pass(DETAIL, out, {
      uImage: { texture: image.texture },
      uBlurred: { texture: t.blurB.texture },
      uBase: { texture: t.base.texture },
      uSize: [w, h],
      uMode: ({ highpass: 0, lineart: 1, edges: 2 } as Record<string, number>)[String(v.detailMode)] ?? 0,
      uContrast: num(v, "contrast", 150) / 100,
      uThreshold: num(v, "threshold", 5) / 100,
      uDetailInk: Math.max(0, Math.min(MAX_INKS - 1, detailInkSlot(v, ctx))),
    });
  },
});
