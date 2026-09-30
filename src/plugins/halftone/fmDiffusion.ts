// FM halftone, error diffusion: each dot cell is set to ink or paper, and the
// difference from the wanted tone is pushed onto the cells not yet visited.
// It needs the whole image (each cell depends on the ones before it), so the
// bitmap is built in a worker from the image's coverage, and the GLSL just
// reads it. The preview builds it at up to 2048 cells across; export builds it
// at full output resolution.

import type { DiffusionOptions, Kernel } from "../../engine/halftone/errorDiffusion";
import { defineSection } from "../../schema/types";
import { halftoneWorker } from "./halftoneWorker";
import { defineHalftoneMethod } from "./types";

export const fmDiffusionSection = defineSection({
  id: "halftoneDiffusion",
  title: "FM: error diffusion",
  stage: "halftone",
  parent: "halftone",
  description: "Classic dithering: each dot passes its tone error to its neighbors. Fine, organic texture.",
  visibleWhen: (s) => s.halftone?.type === "diffusion",
  settings: [
    {
      kind: "select",
      key: "kernel",
      label: "Kernel",
      default: "floyd",
      options: [
        { value: "floyd", label: "Floyd–Steinberg" },
        { value: "atkinson", label: "Atkinson (cleaner highlights and shadows)" },
        { value: "jarvis", label: "Jarvis (smoother)" },
        { value: "stucki", label: "Stucki (smoother, sharper)" },
      ],
    },
    {
      kind: "number",
      key: "dotSize",
      label: "Dot size",
      default: 2,
      min: 1,
      max: 12,
      step: 0.5,
      unit: "px",
      help: "In output pixels, for all inks. Never smaller than the largest minimum dot size.",
    },
    {
      kind: "select",
      key: "shape",
      label: "Dot shape",
      default: "square",
      display: "segmented",
      options: [
        { value: "square", label: "Square" },
        { value: "round", label: "Round" },
      ],
    },
    { kind: "toggle", key: "serpentine", label: "Serpentine scanning", default: true, help: "Alternate direction on every row; avoids streaks." },
    {
      kind: "number",
      key: "noise",
      label: "Threshold noise",
      default: 0,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Randomness in the on/off decision; breaks up worm-like patterns.",
    },
    { kind: "seed", key: "seed", label: "Random seed", default: 1 },
  ],
});

export const fmDiffusion = defineHalftoneMethod({
  id: "diffusion",
  label: "FM: error diffusion",
  section: fmDiffusionSection,
  fromCoverage: {
    // One dot per cell; never smaller than any ink's minimum dot.
    cell: (values, ctx) => Math.max(1, Number(values.dotSize), ...ctx.minDot.slice(0, ctx.inkCount)),
    async build(values, coverage, width, height, inkCount, purpose) {
      const options: DiffusionOptions = {
        kernel: String(values.kernel) as Kernel,
        serpentine: Boolean(values.serpentine),
        noise: Number(values.noise) / 100,
        seed: Number(values.seed),
      };
      // Export builds run on their own worker so preview changes can't cancel them.
      const result = await halftoneWorker(purpose).run(
        { kind: "diffusion", coverage, width, height, inkCount, options },
        { transfer: [coverage.buffer as ArrayBuffer] },
      );
      if (result.kind !== "diffusion") throw new Error("unexpected worker result");
      return result.bits;
    },
  },
  glsl: /* glsl */ `
uniform sampler2D uEdBits;     // one ink per channel, 1 = ink
uniform vec2 uEdGrid;          // cells
uniform float uEdCell;         // output px per cell
uniform int uEdRound;

float edCell(int ink, vec2 cell) {
  if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, uEdGrid))) return 0.0;
  return texelFetch(uEdBits, ivec2(cell), 0)[ink];
}

vec2 htSamplePoint(int ink, vec2 p) { return p; }

float htInk(int ink, vec2 p, float c) {
  vec2 q = p / uEdCell;
  if (uEdRound == 0) return edCell(ink, floor(q)) > 0.5 ? 1.0 : 0.0;
  // Round dots covering one cell's area (radius 1/sqrt(pi)), which may reach into neighbors.
  vec2 home = floor(q);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = home + vec2(float(dx), float(dy));
      vec2 f = q - (cell + 0.5);
      if (dot(f, f) <= 0.3183 && edCell(ink, cell) > 0.5) return 1.0;
    }
  }
  return 0.0;
}
`,
  uniforms(values, ctx, _prepared, bitmap) {
    const gl = ctx.gpu.gl;
    let texture = bitmapTextures.get(bitmap ?? emptyBitmap);
    if (!texture) {
      const b = bitmap ?? emptyBitmap;
      texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, b.width, b.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, b.bits);
      bitmapTextures.set(b, texture);
    }
    const b = bitmap ?? emptyBitmap;
    return {
      uEdBits: { texture },
      uEdGrid: [b.width, b.height],
      uEdCell: b.cell,
      uEdRound: values.shape === "round" ? 1 : 0,
    };
  },
});

const emptyBitmap = { bits: new Uint8Array(4), width: 1, height: 1, cell: 1 };
const bitmapTextures = new WeakMap<object, WebGLTexture>();
