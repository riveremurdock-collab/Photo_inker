// Shared machinery for AM halftones on grids other than the square grid
// (hex, noise grids, phyllotaxis spiral, concentric rings).
//
// Each grid ("lattice") only has to answer: where is the dot center nearest to
// a point? Coordinates are "lattice units": one unit = the ink's cell size,
// and every lattice has one dot per unit of area, like the square grid.
//
// Exact tone for any lattice and dot shape: a point is inked when its "spot
// value" (e.g. squared distance to its dot center, for round dots) is below a
// threshold. The threshold for each tone is measured once by sampling many
// points of that lattice (the share of points below a threshold IS the inked
// area), so a 30% tone always covers 30%, whatever the lattice or shape.

import type { Gpu, UniformValue } from "../../engine/gl/gpu";
import type { SettingDef } from "../../schema/types";
import { createRng } from "../../util/rng";
import { sampleCurve, type CurvePoint } from "../../util/curve";
import type { HalftoneContext } from "./types";

export const LATTICE_SHAPES = ["round", "square", "ellipse", "diamond", "line"] as const;
export type LatticeShape = (typeof LATTICE_SHAPES)[number];

/** Settings every lattice AM type shares (dot shape, max dot, dot size curve). */
export function latticeDotSettings(): SettingDef[] {
  return [
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
    },
  ];
}

/** Spot value of an offset from the dot center (lattice units). Lower = inked first. Mirrors latSpot() in GLSL. */
export function spot(shape: LatticeShape, dx: number, dy: number): number {
  switch (shape) {
    case "round":
      return dx * dx + dy * dy;
    case "square":
      return Math.max(Math.abs(dx), Math.abs(dy));
    case "ellipse":
      return dx * dx + (dy / 0.65) * (dy / 0.65);
    case "diamond":
      return Math.abs(dx) + Math.abs(dy);
    case "line":
      return Math.abs(dy);
  }
}

export const GLSL_LATTICE = /* glsl */ `
uniform vec4 uLatSize;        // cell size per ink, output px
uniform vec4 uLatAngle;       // radians per ink
uniform vec4 uLatMaxDot;
uniform vec4 uLatMinFrac;
uniform int uLatRoundUp;
uniform int uLatShape;        // 0 round, 1 square, 2 ellipse, 3 diamond, 4 line
uniform sampler2D uLatCurve;  // dot size curve
uniform sampler2D uLatCdf;    // 256 × 1, R32F: tone → spot threshold

vec2 latRotate(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

float latTone(int ink, float c) {
  c = texture(uLatCurve, vec2((clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).r * uLatMaxDot[ink];
  if (c < uLatMinFrac[ink]) c = (uLatRoundUp == 1 && c > 0.02) ? uLatMinFrac[ink] : 0.0;
  return c;
}

float latSpot(vec2 d) {
  if (uLatShape == 1) return max(abs(d.x), abs(d.y));
  if (uLatShape == 2) return d.x * d.x + (d.y / 0.65) * (d.y / 0.65);
  if (uLatShape == 3) return abs(d.x) + abs(d.y);
  if (uLatShape == 4) return abs(d.y);
  return dot(d, d);
}

float latThreshold(float c) {
  float x = clamp(c, 0.0, 1.0) * 255.0;
  int i = int(floor(x));
  float a = texelFetch(uLatCdf, ivec2(min(i, 255), 0), 0).r;
  float b = texelFetch(uLatCdf, ivec2(min(i + 1, 255), 0), 0).r;
  return mix(a, b, fract(x));
}
`;

/**
 * The standard htSamplePoint/htInk for a lattice. The method's GLSL must define
 *   vec2 latToLattice(int ink, vec2 p);     // output px → lattice units
 *   vec2 latFromLattice(int ink, vec2 q);   // lattice units → output px
 *   vec2 latNearest(int ink, vec2 q);       // nearest dot center (lattice units)
 */
export const GLSL_LATTICE_HT = /* glsl */ `
vec2 htSamplePoint(int ink, vec2 p) {
  return latFromLattice(ink, latNearest(ink, latToLattice(ink, p)));
}

float htInk(int ink, vec2 p, float c) {
  c = latTone(ink, c);
  if (c <= 0.0) return 0.0;
  if (c >= 0.999) return 1.0;
  vec2 q = latToLattice(ink, p);
  return latSpot(q - latNearest(ink, q)) < latThreshold(c) ? 1.0 : 0.0;
}
`;

/**
 * Measures the lattice: for each tone (256 steps), the spot threshold that
 * inks exactly that share of the area. `nearest` must match the GLSL; points
 * are sampled uniformly from `region` (lattice units).
 */
export function measureThresholds(
  nearest: (x: number, y: number) => [number, number],
  shape: LatticeShape,
  region: (rng: () => number) => [number, number],
  samples = 65536,
): Float32Array {
  const rng = createRng(12345);
  const values = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const [x, y] = region(rng);
    const [cx, cy] = nearest(x, y);
    values[i] = spot(shape, x - cx, y - cy);
  }
  values.sort();
  const out = new Float32Array(256);
  for (let t = 0; t < 256; t++) {
    const q = (t / 255) * (samples - 1);
    const lo = Math.floor(q);
    const hi = Math.min(samples - 1, lo + 1);
    out[t] = values[lo]! + (values[hi]! - values[lo]!) * (q - lo);
  }
  // Tone 0 must ink nothing, even exactly at a dot center.
  out[0] = -1;
  return out;
}

// ---- Textures shared by lattice methods ----

const cache = new WeakMap<WebGL2RenderingContext, Map<string, WebGLTexture>>();

export function floatTexture(gpu: Gpu, key: string, width: number, height: number, data: Float32Array, channels: 1 | 4 = 1): WebGLTexture {
  const gl = gpu.gl;
  let m = cache.get(gl);
  if (!m) cache.set(gl, (m = new Map()));
  let tex = m.get(key);
  if (tex) return tex;
  tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, channels === 1 ? gl.R32F : gl.RGBA32F, width, height, 0, channels === 1 ? gl.RED : gl.RGBA, gl.FLOAT, data);
  m.set(key, tex);
  return tex;
}

let lastCurve: { key: string; tex: WebGLTexture; gl: WebGL2RenderingContext } | null = null;

function curveTexture(gpu: Gpu, curve: readonly CurvePoint[]): WebGLTexture {
  const key = JSON.stringify(curve);
  if (lastCurve && lastCurve.key === key && lastCurve.gl === gpu.gl) return lastCurve.tex;
  const gl = gpu.gl;
  const tex = lastCurve?.gl === gl ? lastCurve.tex : gl.createTexture()!;
  const samples = sampleCurve(curve, 256);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, Uint8Array.from(samples, (v) => Math.round(v * 255)));
  lastCurve = { key, tex, gl };
  return tex;
}

const SHAPE_INDEX: Record<LatticeShape, number> = { round: 0, square: 1, ellipse: 2, diamond: 3, line: 4 };

/** Uniforms for GLSL_LATTICE. `cdfKey` identifies the lattice + shape for caching the measured thresholds. */
export function latticeUniforms(
  values: Record<string, unknown>,
  ctx: HalftoneContext,
  sizeKey: string,
  angleKey: string | null,
  cdf: { key: string; measure: () => Float32Array },
): Record<string, UniformValue> {
  const size = (values[sizeKey] as number[]) ?? [];
  const angle = angleKey ? ((values[angleKey] as number[]) ?? []) : [];
  const maxDot = (values.maxDot as number[]) ?? [];
  const vec = (f: (i: number) => number) => Array.from({ length: 4 }, (_, i) => (i < ctx.inkCount ? f(i) : 1));
  const shape = (values.shape as LatticeShape) ?? "round";
  const key = `${cdf.key}|${shape}`;
  let cached = thresholds.get(key);
  if (!cached) thresholds.set(key, (cached = cdf.measure()));
  return {
    uLatSize: vec((i) => Math.max(1, size[i] ?? 8)),
    uLatAngle: vec((i) => ((angle[i] ?? 0) * Math.PI) / 180),
    uLatMaxDot: vec((i) => (maxDot[i] ?? 100) / 100),
    // A round dot of diameter d covers (π/4)·d² of a cell of size s².
    uLatMinFrac: vec((i) => {
      const d = ctx.minDot[i] ?? 0;
      const s = Math.max(1, size[i] ?? 8);
      return Math.min(1, ((Math.PI / 4) * d * d) / (s * s));
    }),
    uLatRoundUp: ctx.minDotMode === "round" ? 1 : 0,
    uLatShape: SHAPE_INDEX[shape] ?? 0,
    uLatCurve: { texture: curveTexture(ctx.gpu, (values.curve as CurvePoint[]) ?? [[0, 0], [1, 1]]) },
    uLatCdf: { texture: floatTexture(ctx.gpu, `cdf:${key}`, 256, 1, cached) },
  };
}

const thresholds = new Map<string, Float32Array>();
