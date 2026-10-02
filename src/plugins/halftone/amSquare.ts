// AM halftone on a square grid: dots sit on a rotated grid (angle per ink),
// and dot size carries the tone.
//
// Dot shapes are "spot functions" over the cell. Each shape is turned into a
// rank table: every point of the cell gets the fraction of the cell that fills
// in before it. A point is inked when its rank is below the tone, so a dot
// always covers exactly the tone's share of the cell, whatever its shape.

import type { Gpu } from "../../engine/gl/gpu";
import { defineSection } from "../../schema/types";
import { sampleCurve, type CurvePoint } from "../../util/curve";
import { defineHalftoneMethod } from "./types";

export const DOT_SHAPES = ["round", "square", "ellipse", "diamond", "line"] as const;
export type DotShape = (typeof DOT_SHAPES)[number];

/** Standard screen angles (degrees) by print order, as used for CMYK. */
export const STANDARD_ANGLES = [15, 75, 0, 45];

export const amSquareSection = defineSection({
  id: "halftoneAm",
  title: "AM: square grid",
  stage: "halftone",
  parent: "halftone",
  description: "Dots sit on a grid; dot size carries the tone. Each ink gets its own angle to avoid moiré.",
  visibleWhen: (s) => s.halftone?.type === "am",
  settings: [
    {
      kind: "number",
      key: "cellSize",
      label: "Cell size",
      perInk: true,
      default: 8,
      min: 2,
      max: 64,
      step: 0.5,
      unit: "px",
      help: "Distance between dots, in output pixels. At 600 DPI: 6 px ≈ 100 LPI, 8 px = 75 LPI, 12 px = 50 LPI.",
    },
    {
      kind: "number",
      key: "angle",
      linkInks: false,
      label: "Angle",
      perInk: true,
      default: 45,
      slotDefaults: STANDARD_ANGLES,
      min: 0,
      max: 90,
      step: 0.5,
      unit: "°",
    },
    {
      kind: "number",
      key: "maxDot",
      label: "Maximum dot size",
      perInk: true,
      default: 100,
      min: 10,
      max: 100,
      step: 1,
      unit: "%",
      help: "Largest dot, as a share of the cell. Below 100% even solid areas keep small gaps.",
    },
    {
      kind: "select",
      key: "shape",
      label: "Dot shape",
      default: "round",
      options: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
        { value: "ellipse", label: "Ellipse" },
        { value: "diamond", label: "Diamond" },
        { value: "line", label: "Line" },
      ],
    },
    {
      kind: "curve",
      key: "curve",
      label: "Dot size curve",
      default: [
        [0, 0],
        [1, 1],
      ],
      help: "Maps tone to dot size. Pull the middle down for smaller dots in the midtones.",
    },
  ],
});

const RANK_SIZE = 128;

function spot(shape: DotShape, u: number, v: number): number {
  const au = Math.abs(u);
  const av = Math.abs(v);
  switch (shape) {
    case "round":
      // Euclidean dot: round dots in the highlights, round holes in the shadows.
      return au + av <= 1 ? u * u + v * v : 2 - ((1 - au) ** 2 + (1 - av) ** 2);
    case "square":
      return Math.max(au, av);
    case "ellipse":
      return Math.sqrt(u * u + (v / 0.65) ** 2);
    case "diamond":
      return au + av;
    case "line":
      return av;
  }
}

/** Rank table for a shape: R8 values, rank / N over a RANK_SIZE² grid covering one cell. */
function rankTable(shape: DotShape): Uint8Array {
  const n = RANK_SIZE * RANK_SIZE;
  const values = new Float64Array(n);
  for (let y = 0; y < RANK_SIZE; y++) {
    for (let x = 0; x < RANK_SIZE; x++) {
      const u = ((x + 0.5) / RANK_SIZE) * 2 - 1;
      const v = ((y + 0.5) / RANK_SIZE) * 2 - 1;
      // A tiny tilt breaks exact ties so equal-valued points fill in a stable order.
      values[y * RANK_SIZE + x] = spot(shape, u, v) + (x * 1e-9 + y * 1e-12);
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const out = new Uint8Array(n);
  order.forEach((idx, rank) => (out[idx] = Math.round(((rank + 0.5) / n) * 255)));
  return out;
}

const textures = new WeakMap<WebGL2RenderingContext, Map<string, { tex: WebGLTexture; data: Uint8Array | null }>>();

function texture(gpu: Gpu, key: string, width: number, height: number, data: Uint8Array, wrap: "repeat" | "clamp"): WebGLTexture {
  const gl = gpu.gl;
  let cache = textures.get(gl);
  if (!cache) textures.set(gl, (cache = new Map()));
  let entry = cache.get(key);
  if (entry && entry.data === data) return entry.tex;
  if (!entry) {
    const tex = gl.createTexture()!;
    entry = { tex, data: null };
    cache.set(key, entry);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
  }
  gl.bindTexture(gl.TEXTURE_2D, entry.tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  entry.data = data;
  return entry.tex;
}

const rankCache = new Map<DotShape, Uint8Array>();
function spotTexture(gpu: Gpu, shape: DotShape): WebGLTexture {
  let table = rankCache.get(shape);
  if (!table) rankCache.set(shape, (table = rankTable(shape)));
  return texture(gpu, `spot:${shape}`, RANK_SIZE, RANK_SIZE, table, "repeat");
}

let lastCurve: { key: string; bytes: Uint8Array } | null = null;
function curveTexture(gpu: Gpu, curve: readonly CurvePoint[]): WebGLTexture {
  const key = JSON.stringify(curve);
  if (lastCurve?.key !== key) {
    const samples = sampleCurve(curve, 256);
    lastCurve = { key, bytes: Uint8Array.from(samples, (v) => Math.round(v * 255)) };
  }
  return texture(gpu, "amCurve", 256, 1, lastCurve.bytes, "clamp");
}

export const amSquare = defineHalftoneMethod({
  id: "am",
  label: "AM: square grid",
  section: amSquareSection,
  glsl: /* glsl */ `
uniform vec4 uAmCell;       // cell size per ink, output px
uniform vec4 uAmAngle;      // radians
uniform vec4 uAmMaxDot;     // 0..1
uniform vec4 uAmMinFrac;    // minimum dot area as a share of the cell
uniform int uAmRoundUp;
uniform sampler2D uAmSpot;  // rank table over one cell (repeats)
uniform sampler2D uAmCurve; // dot size curve

vec2 amRotate(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

vec2 htSamplePoint(int ink, vec2 p) {
  float size = uAmCell[ink];
  vec2 q = amRotate(p, uAmAngle[ink]) / size;
  return amRotate((floor(q) + 0.5) * size, -uAmAngle[ink]);
}

float htInk(int ink, vec2 p, float c) {
  c = texture(uAmCurve, vec2((clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).r * uAmMaxDot[ink];
  if (c < uAmMinFrac[ink]) c = (uAmRoundUp == 1 && c > 0.02) ? uAmMinFrac[ink] : 0.0;
  if (c <= 0.0) return 0.0;
  if (c >= 0.999) return 1.0;
  vec2 q = amRotate(p, uAmAngle[ink]) / uAmCell[ink];
  return texture(uAmSpot, fract(q)).r < c ? 1.0 : 0.0;
}
`,
  uniforms(values, ctx) {
    const vec = (f: (i: number) => number) => Array.from({ length: 4 }, (_, i) => (i < ctx.inkCount ? f(i) : 1));
    return {
      uAmCell: vec((i) => Math.max(1, values.cellSize[i] ?? 8)),
      uAmAngle: vec((i) => ((values.angle[i] ?? 45) * Math.PI) / 180),
      uAmMaxDot: vec((i) => (values.maxDot[i] ?? 100) / 100),
      // A round dot of diameter d covers (π/4)·d² of a cell of size s².
      uAmMinFrac: vec((i) => {
        const d = ctx.minDot[i] ?? 0;
        const s = Math.max(1, values.cellSize[i] ?? 8);
        return Math.min(1, (Math.PI / 4) * (d * d) / (s * s));
      }),
      uAmRoundUp: ctx.minDotMode === "round" ? 1 : 0,
      uAmSpot: { texture: spotTexture(ctx.gpu, values.shape as DotShape) },
      uAmCurve: { texture: curveTexture(ctx.gpu, values.curve) },
    };
  },
});
