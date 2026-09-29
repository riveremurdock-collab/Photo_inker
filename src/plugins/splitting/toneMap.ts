// Tone Map (Simple mode): maps the image's lightness to ink density in bands
// (e.g. shadows, midtones, highlights), each band assigned an ink, with overlap
// zones blending neighboring bands. Bands become per-ink curves (toneCurves.ts),
// and a GPU pass looks each pixel's lightness up in those curves.

import { LIGHTNESS_SOURCES, GLSL_LIGHTNESS, GLSL_LINEAR_TO_SRGB } from "../../engine/gl/program";
import { MAX_INKS } from "../../pipeline/coverage";
import { defineSection, type SectionValues } from "../../schema/types";
import { bandsToCurves, CURVE_SIZE, resolveBandInks, type Falloff, type Fill } from "./toneCurves";
import { defineSplitMethod, type SplitContext } from "./types";

const BAND_INK_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "paper", label: "Paper (no ink)" },
  { value: "0", label: "Ink 1" },
  { value: "1", label: "Ink 2" },
  { value: "2", label: "Ink 3" },
  { value: "3", label: "Ink 4" },
] as const;

export const toneMapSection = defineSection({
  id: "splitToneMap",
  title: "Tone Map",
  stage: "split",
  parent: "split",
  description: "Maps lightness to ink in bands, like shadows, midtones, and highlights. Good for graphic looks and duotones.",
  visibleWhen: (s) => s.split?.method === "toneMap",
  settings: [
    {
      kind: "select",
      key: "source",
      label: "Lightness source",
      default: "luma",
      options: [
        { value: "luma", label: "Luma" },
        { value: "lstar", label: "L* (perceptual)" },
        { value: "red", label: "Red channel" },
        { value: "green", label: "Green channel" },
        { value: "blue", label: "Blue channel" },
        { value: "max", label: "Max RGB" },
        { value: "min", label: "Min RGB" },
      ],
    },
    { kind: "number", key: "bandCount", label: "Number of bands", default: 4, min: 1, max: 4, step: 1 },
    // Band edges are dragged on the histogram (custom block), so they're hidden here.
    { kind: "number", key: "cutoff1", label: "Cutoff 1", default: 25, min: 0, max: 100, step: 0.5, hidden: true },
    { kind: "number", key: "cutoff2", label: "Cutoff 2", default: 50, min: 0, max: 100, step: 0.5, hidden: true },
    { kind: "number", key: "cutoff3", label: "Cutoff 3", default: 75, min: 0, max: 100, step: 0.5, hidden: true },
    { kind: "select", key: "band1Ink", label: "Band 1 ink", default: "auto", options: BAND_INK_OPTIONS, hidden: true },
    { kind: "select", key: "band2Ink", label: "Band 2 ink", default: "auto", options: BAND_INK_OPTIONS, hidden: true },
    { kind: "select", key: "band3Ink", label: "Band 3 ink", default: "auto", options: BAND_INK_OPTIONS, hidden: true },
    { kind: "select", key: "band4Ink", label: "Band 4 ink", default: "auto", options: BAND_INK_OPTIONS, hidden: true },
    {
      kind: "number",
      key: "overlap1",
      label: "Overlap, bands 1–2",
      default: 6,
      min: 0,
      max: 40,
      step: 0.5,
      unit: "%",
      visibleWhen: (s) => Number(s.bandCount) >= 2,
    },
    {
      kind: "number",
      key: "overlap2",
      label: "Overlap, bands 2–3",
      default: 6,
      min: 0,
      max: 40,
      step: 0.5,
      unit: "%",
      visibleWhen: (s) => Number(s.bandCount) >= 3,
    },
    {
      kind: "number",
      key: "overlap3",
      label: "Overlap, bands 3–4",
      default: 6,
      min: 0,
      max: 40,
      step: 0.5,
      unit: "%",
      visibleWhen: (s) => Number(s.bandCount) >= 4,
    },
    {
      kind: "select",
      key: "falloff",
      label: "Falloff",
      default: "smooth",
      display: "segmented",
      options: [
        { value: "hard", label: "Hard" },
        { value: "linear", label: "Linear" },
        { value: "smooth", label: "Smooth" },
      ],
    },
    {
      kind: "select",
      key: "fill",
      label: "Fill inside each band",
      default: "flat",
      display: "segmented",
      options: [
        { value: "flat", label: "Flat" },
        { value: "gradient", label: "Tonal gradient" },
      ],
    },
    {
      kind: "number",
      key: "posterize",
      label: "Posterize steps",
      default: 0,
      min: 0,
      max: 8,
      step: 1,
      help: "Steps within each band. 0 = smooth.",
      visibleWhen: (s) => s.fill === "gradient",
    },
  ],
});

type ToneMapValues = SectionValues<typeof toneMapSection>;

export function toneMapBandInks(values: ToneMapValues, inkHexes: readonly string[]): (number | null)[] {
  return resolveBandInks(
    [values.band1Ink, values.band2Ink, values.band3Ink, values.band4Ink],
    values.bandCount,
    inkHexes,
  );
}

/** Sorted cutoffs (0..1) for the current band count. */
export function toneMapCutoffs(values: ToneMapValues): number[] {
  return [values.cutoff1, values.cutoff2, values.cutoff3]
    .slice(0, values.bandCount - 1)
    .map((c) => c / 100)
    .sort((a, b) => a - b);
}

export function toneMapCurves(values: ToneMapValues, inkHexes: readonly string[]): Float32Array {
  return bandsToCurves({
    cutoffs: toneMapCutoffs(values),
    bandInks: toneMapBandInks(values, inkHexes),
    overlaps: [values.overlap1, values.overlap2, values.overlap3].map((o) => o / 100),
    falloff: values.falloff as Falloff,
    fill: values.fill as Fill,
    posterize: values.posterize,
  });
}

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform sampler2D uCurves; // CURVE_SIZE × 1, one ink per channel
uniform int uSource;
uniform vec2 uSize;
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}
${GLSL_LIGHTNESS}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float l = clamp(lightness(texture(uImage, uv).rgb, uSource), 0.0, 1.0);
  outColor = texture(uCurves, vec2((l * ${CURVE_SIZE - 1}.0 + 0.5) / ${CURVE_SIZE}.0, 0.5));
}
`;

const curveTextures = new WeakMap<WebGL2RenderingContext, WebGLTexture>();

function uploadCurves(gl: WebGL2RenderingContext, curves: Float32Array): WebGLTexture {
  let tex = curveTextures.get(gl);
  if (!tex) {
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    curveTextures.set(gl, tex);
  }
  const bytes = new Uint8Array(CURVE_SIZE * MAX_INKS);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(curves[i]! * 255);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, CURVE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return tex;
}

const inkHexes = (ctx: SplitContext) => ctx.inks.map((i) => i.hex);

export const toneMap = defineSplitMethod({
  id: "toneMap",
  label: "Tone Map",
  section: toneMapSection,
  // Only "auto" band inks depend on the ink colors (their lightness order), so
  // the result changes with ink colors only if the resolved band inks change.
  dependsOn: (ctx, values) => toneMapBandInks(values, inkHexes(ctx)),
  render(ctx, image, out, values) {
    const curves = toneMapCurves(values, inkHexes(ctx));
    const tex = uploadCurves(ctx.gpu.gl, curves);
    ctx.gpu.pass(FRAGMENT, out, {
      uImage: { texture: image.texture },
      uCurves: { texture: tex },
      uSource: Math.max(0, LIGHTNESS_SOURCES.indexOf(values.source as (typeof LIGHTNESS_SOURCES)[number])),
      uSize: [out.width, out.height],
    });
  },
});
