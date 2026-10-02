// Ink Matching (unmixing): for each pixel, the amount of each ink that best
// reproduces the original color, using the same spectral ink model as the
// preview and a perceptual (Lab) color difference.
//
// A worker solves a 3D lookup table over sRGB (engine/spectral/solver.ts);
// this module uploads it as a 3D texture and a GPU pass looks up every pixel.
// A quick 17³ draft is shown first, then the full 33³ table replaces it.

import { TextureCache } from "../../engine/gl/textureCache";
import { GLSL_LINEAR_TO_SRGB } from "../../engine/gl/program";
import { defineSection } from "../../schema/types";
import type { InkMatchRequest, InkMatchResult } from "../../workers/inkMatchTypes";
import { WorkerClient } from "../../workers/workerClient";
import { defineSplitMethod } from "./types";

export const inkMatchingSection = defineSection({
  id: "splitInkMatching",
  title: "Ink Matching",
  stage: "split",
  parent: "split",
  description: "Finds the mix of your inks that best matches each color. Realistic photo reproduction with any ink set.",
  visibleWhen: (s) => s.split?.method === "inkMatching",
  settings: [
    {
      kind: "number",
      key: "priority",
      label: "Ink priority",
      perInk: true,
      default: 50,
      min: 0,
      max: 100,
      step: 1,
      help: "When several ink mixes would match a color, inks with higher priority are used first.",
    },
    {
      kind: "number",
      key: "sparsity",
      label: "Prefer fewer inks",
      default: 25,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Higher values use fewer overlapping inks per spot, for cleaner, less muddy color.",
    },
    {
      kind: "select",
      key: "gamut",
      label: "Colors the inks can't reach",
      default: "compress",
      display: "segmented",
      options: [
        { value: "compress", label: "Compress" },
        { value: "clip", label: "Clip" },
      ],
      help: "Compress matches colors relative to the paper (white in the image stays bare paper) and fits the full light-to-dark range into what the inks can print, keeping shadow detail. Clip matches exact colors, using the closest mix for each.",
    },
    {
      kind: "number",
      key: "balance",
      label: "Preserve lightness ↔ hue",
      default: 50,
      min: 0,
      max: 100,
      step: 1,
      help: "Left keeps lightness accurate; right keeps hue accurate.",
    },
  ],
});

const DRAFT_SIZE = 17;
const FINAL_SIZE = 33;

let client: WorkerClient<InkMatchRequest, InkMatchResult> | null = null;
function worker(): WorkerClient<InkMatchRequest, InkMatchResult> {
  client ??= new WorkerClient(new Worker(new URL("../../workers/inkMatch.worker.ts", import.meta.url), { type: "module" }));
  return client;
}

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uImage;
uniform sampler3D uLut;
uniform float uLutSize;
uniform vec2 uSize;
out vec4 outColor;
${GLSL_LINEAR_TO_SRGB}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 s = linearToSrgb(texture(uImage, uv).rgb);
  outColor = texture(uLut, (s * (uLutSize - 1.0) + 0.5) / uLutSize);
}
`;

const lutTextures = new TextureCache<InkMatchResult>();

function lutTexture(gl: WebGL2RenderingContext, lut: InkMatchResult): WebGLTexture {
  return lutTextures.get(gl, lut, () => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.lut);
    return texture;
  });
}

export const inkMatching = defineSplitMethod({
  id: "inkMatching",
  label: "Ink Matching",
  section: inkMatchingSection,
  // The solution depends on every ink's color and opacity, and the paper.
  dependsOn: (ctx) => ({ paper: ctx.paper, inks: ctx.inks }),
  async prepare(values, ctx, quality): Promise<InkMatchResult> {
    return worker().run({
      size: quality === "draft" ? DRAFT_SIZE : FINAL_SIZE,
      options: {
        inkCount: ctx.inkCount,
        table: Float32Array.from(ctx.table.colors),
        priority: values.priority.slice(0, ctx.inkCount).map((p) => p / 100),
        sparsity: values.sparsity / 100,
        balance: values.balance / 100,
        compress: values.gamut === "compress",
      },
    });
  },
  render(ctx, image, out, _values, prepared) {
    if (!prepared) return;
    ctx.gpu.pass(FRAGMENT, out, {
      uImage: { texture: image.texture },
      uLut: { texture: lutTexture(ctx.gpu.gl, prepared), target: "3d" },
      uLutSize: prepared.size,
      uSize: [out.width, out.height],
    });
  },
});
