// FM halftone, stipple: hand-stippled dots with no grid. More dots in darker
// areas, placed by an evenly spread random point set (engine/halftone/stipple.ts),
// each dot with its own size, outline, angle and grain. The worker builds the
// point set once and measures the tone for the current dot settings, so the
// printed share of ink matches the image however the dots overlap.

import {
  deriveStipple,
  STIPPLE_LEVELS,
  STIPPLE_MAX_REACH,
  STIPPLE_SLOTS,
  STIPPLE_TILE,
  type StippleParams,
} from "../../engine/halftone/stipple";
import { defineSection } from "../../schema/types";
import { createRng } from "../../util/rng";
import { halftoneWorker } from "./halftoneWorker";
import { floatTexture } from "./lattice";
import { defineHalftoneMethod } from "./types";

export const fmStippleSection = defineSection({
  id: "halftoneStipple",
  title: "FM: stipple",
  stage: "halftone",
  parent: "halftone",
  description: "Hand-stippled dots with no grid: every dot a little different, more of them in darker areas.",
  visibleWhen: (s) => s.halftone?.type === "stipple",
  settings: [
    {
      kind: "number",
      key: "dotSize",
      label: "Dot size",
      perInk: true,
      default: 4,
      min: 1,
      max: 24,
      step: 0.5,
      unit: "px",
      help: "Typical dot diameter in output pixels (at mid tones).",
    },
    {
      kind: "select",
      key: "shape",
      label: "Dot shape",
      default: "round",
      display: "segmented",
      options: [
        { value: "round", label: "Round" },
        { value: "chip", label: "Chip" },
        { value: "dash", label: "Dash" },
      ],
      help: "Round: pen dots. Chip: angular flecks, like a carved block. Dash: short pen strokes.",
    },
    { kind: "number", key: "sizeVariation", label: "Size variation", default: 30, min: 0, max: 100, step: 1, unit: "%", help: "Random difference in size from dot to dot." },
    {
      kind: "number",
      key: "toneSize",
      label: "Size follows tone",
      default: 40,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Bigger dots in dark areas and smaller ones in light areas, like pressing harder with the pen.",
    },
    {
      kind: "number",
      key: "irregularity",
      label: "Placement irregularity",
      default: 25,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "0 = evenly spaced; higher = looser, more random spacing with small gaps and clusters.",
    },
    { kind: "number", key: "wobble", label: "Shape wobble", default: 35, min: 0, max: 100, step: 1, unit: "%", help: "How lumpy and uneven each dot's outline is." },
    { kind: "number", key: "roughness", label: "Edge roughness", default: 20, min: 0, max: 100, step: 1, unit: "%", help: "Fine ragged detail along each dot's edge." },
    { kind: "number", key: "stretch", label: "Stretch", default: 0, min: 0, max: 100, step: 1, unit: "%", help: "Makes dots longer in one direction." },
    {
      kind: "number",
      key: "direction",
      label: "Direction",
      default: 30,
      min: 0,
      max: 180,
      step: 1,
      unit: "°",
      visibleWhen: (s) => Number(s.stretch) > 0 || s.shape === "dash",
    },
    {
      kind: "number",
      key: "directionVariation",
      label: "Direction variation",
      default: 100,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "0 = every dot at the same angle (a steady hand); 100 = any angle.",
      visibleWhen: (s) => Number(s.stretch) > 0 || s.shape === "dash",
    },
    { kind: "number", key: "bleed", label: "Ink bleed", default: 0, min: 0, max: 100, step: 1, unit: "%", help: "Nearby dots flow into each other, like wet ink." },
    { kind: "number", key: "grain", label: "Ink grain", default: 0, min: 0, max: 100, step: 1, unit: "%", help: "Gritty, uneven ink: pitted edges and specks of paper inside dots." },
    { kind: "seed", key: "seed", label: "Random seed", default: 1 },
  ],
});

type Values = Record<string, unknown>;

const SHAPES: Record<string, number> = { round: 0, chip: 1, dash: 2 };

function params(v: Values): StippleParams {
  return {
    shape: SHAPES[String(v.shape)] ?? 0,
    sizeVar: Number(v.sizeVariation) / 100,
    toneSize: Number(v.toneSize) / 100,
    wobble: Number(v.wobble) / 100,
    rough: Number(v.roughness) / 100,
    stretch: Number(v.stretch) / 100,
    dirAngle: (Number(v.direction) * Math.PI) / 180,
    dirVar: Number(v.directionVariation) / 100,
    bleed: Number(v.bleed) / 100,
    grain: Number(v.grain) / 100,
  };
}

interface Prepared {
  points: Uint8Array;
  table: Float32Array;
  key: string;
}

// The point buckets only change with irregularity; keep the last set so tweaking
// other settings only re-measures the tone.
let lastPoints: { irregularity: number; data: Promise<Uint8Array> } | null = null;

function pointsFor(irregularity: number): Promise<Uint8Array> {
  if (lastPoints?.irregularity !== irregularity) {
    const data = halftoneWorker("stipple")
      .run({ kind: "stipplePoints", irregularity })
      .then((r) => {
        if (r.kind !== "stipplePoints") throw new Error("unexpected worker result");
        return r.data;
      });
    const entry = { irregularity, data };
    lastPoints = entry;
    data.catch(() => {
      if (lastPoints === entry) lastPoints = null;
    });
  }
  return lastPoints!.data;
}

const T = STIPPLE_TILE;
const S = STIPPLE_SLOTS;

export const fmStipple = defineHalftoneMethod({
  id: "stipple",
  label: "FM: stipple",
  section: fmStippleSection,
  reach(values, ctx) {
    const dv = deriveStipple(params(values as never));
    const sizes = (values.dotSize as number[]).slice(0, ctx.inkCount);
    return Math.max(...sizes.map((d, i) => Math.max(1, d, ctx.minDot[i] ?? 0))) * (dv.reach + 1);
  },
  prepareKey: (values) => JSON.stringify([values.irregularity, params(values as never)]),
  async prepare(values): Promise<Prepared> {
    const irregularity = Number(values.irregularity) / 100;
    const points = await pointsFor(irregularity);
    const result = await halftoneWorker("stipple").run({ kind: "stippleMeasure", irregularity, params: params(values as never) });
    if (result.kind !== "stippleMeasure") throw new Error("unexpected worker result");
    return { points, table: result.table, key: JSON.stringify([irregularity, params(values as never)]) };
  },
  glsl: /* glsl */ `
uniform sampler2D uStPoints;   // ${T * S} × ${T}: per bucket ${S} slots of (x, y, rank hi, rank lo)
uniform sampler2D uStTable;    // ${STIPPLE_LEVELS} × 1: tone → rank threshold
uniform vec4 uStDot;           // dot size per ink, output px
uniform vec4 uStMinFrac;       // minimum dot / dot size, per ink
uniform vec2 uStOffset[4];     // per-ink view into the point set (dot units, ≥ ${T})
uniform int uStSeed;
uniform int uStShape;
uniform float uStReach;
uniform float uStSizeVar;
uniform float uStToneSize;
uniform float uStWobble;
uniform float uStRough;
uniform float uStDirAngle;
uniform float uStDirVar;
uniform float uStBleed;
uniform float uStGrain;
uniform float uStMajor;
uniform float uStMinor;
uniform float uStExtent;

uint stHash(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
float stRnd(uint base, int k) { return float(stHash(base + uint(k) * 0x9E3779B9u) >> 8u) / 16777216.0; }
float stCorner(int ix, int iy, uint seed) {
  return float(stHash((uint(ix) * 73856093u) ^ (uint(iy) * 19349663u) ^ seed) >> 8u) / 16777216.0;
}
float stNoise(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x), iy = int(i.y);
  float a = stCorner(ix, iy, seed), b = stCorner(ix + 1, iy, seed);
  float c = stCorner(ix, iy + 1, seed), d = stCorner(ix + 1, iy + 1, seed);
  return a + (b - a) * f.x + (c - a) * f.y + (a - b - c + d) * f.x * f.y;
}
float stSmin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float stThreshold(float c) {
  float x = clamp(c, 0.0, 1.0) * ${(STIPPLE_LEVELS - 1).toFixed(1)};
  int i = int(floor(x));
  float a = texelFetch(uStTable, ivec2(min(i, ${STIPPLE_LEVELS - 1}), 0), 0).r;
  float b = texelFetch(uStTable, ivec2(min(i + 1, ${STIPPLE_LEVELS - 1}), 0), 0).r;
  return mix(a, b, fract(x));
}

// Mirrors stippleSdf() in engine/halftone/stipple.ts. v and the result are in dot units.
float stSdf(vec2 v, float c, uint base, float minFrac) {
  const float PI = 3.14159265;
  float g = 1.0 + uStToneSize * (c - 0.5);
  float s = exp(0.7 * uStSizeVar * (2.0 * stRnd(base, 0) - 1.0));
  float r = max(0.5 * s * g, 0.5 * minFrac);
  float bound = r * uStMajor * uStExtent + uStBleed * 0.5;
  if (dot(v, v) > bound * bound) return 1e9;
  float ang = uStDirAngle + uStDirVar * (stRnd(base, 1) - 0.5) * 2.0 * PI;
  float ca = cos(ang), sa = sin(ang);
  vec2 u = vec2((ca * v.x + sa * v.y) / (r * uStMajor), (-sa * v.x + ca * v.y) / (r * uStMinor));
  float len = length(u);
  float th = len < 1e-4 ? 0.0 : atan(u.y, u.x);
  float R = 1.0;
  if (uStShape == 1) {
    float n = 3.0 + floor(stRnd(base, 2) * 4.0);
    float sec = 2.0 * PI / n;
    float m = mod(th + PI, sec);
    R = cos(PI / n) / cos(m - PI / n);
  }
  if (uStWobble > 0.0) {
    float w = 0.0;
    for (int k = 2; k <= 4; k++) w += (2.0 * stRnd(base, 1 + k) - 1.0) * (0.3 / float(k)) * cos(float(k) * th + 2.0 * PI * stRnd(base, 4 + k));
    R += uStWobble * w;
  }
  if (uStRough > 0.0) {
    float w = stRnd(base, 9) * 0.12 * cos(7.0 * th + 2.0 * PI * stRnd(base, 12))
      + stRnd(base, 10) * 0.12 * sqrt(7.0 / 11.0) * cos(11.0 * th + 2.0 * PI * stRnd(base, 13))
      + stRnd(base, 11) * 0.12 * sqrt(7.0 / 17.0) * cos(17.0 * th + 2.0 * PI * stRnd(base, 14));
    R += uStRough * w;
  }
  float sdf = len - R;
  if (uStGrain > 0.0) sdf += uStGrain * (stNoise(u * 2.5 + 64.0, stHash(base + 15u)) - 0.3) * 1.4;
  return sdf * r * uStMinor;
}

vec2 htSamplePoint(int ink, vec2 p) { return p; }

float htInk(int ink, vec2 p, float c) {
  if (c >= 0.995) return 1.0;
  float D = uStDot[ink];
  vec2 q = p / D + uStOffset[ink];
  ivec2 lo = ivec2(floor(q - uStReach));
  ivec2 hi = ivec2(floor(q + uStReach));
  float reach2 = uStReach * uStReach;
  float acc = 1e9;
  for (int by = lo.y; by <= hi.y; by++) {
    int wy = by % ${T};
    for (int bx = lo.x; bx <= hi.x; bx++) {
      int wx = bx % ${T};
      uint salt = stHash(uint(bx / ${T}) * 0x9E3779B1u ^ uint(by / ${T}) * 0x85EBCA77u ^ uint(ink) * 0xC2B2AE3Du ^ uint(uStSeed) * 0x27D4EB2Fu);
      for (int j = 0; j < ${S}; j++) {
        vec4 s = texelFetch(uStPoints, ivec2(wx * ${S} + j, wy), 0) * 255.0;
        float rank16 = s.b * 256.0 + s.a;
        if (rank16 > 65534.5) break;
        vec2 center = vec2(float(bx), float(by)) + (s.rg + 0.5) / 255.0;
        vec2 v = q - center;
        if (dot(v, v) > reach2) continue;
        // Each dot takes the tone at its own center, so dots are never cut in half by an edge.
        float ci = htCoverage(ink, (center - uStOffset[ink]) * D);
        if (ci <= 0.002 || rank16 / 65535.0 >= stThreshold(ci)) continue;
        uint id = uint((wy * ${T} + wx) * ${S} + j);
        acc = stSmin(acc, stSdf(v, ci, stHash(id ^ salt), uStMinFrac[ink]), uStBleed * 0.5);
        if (acc < 0.0) return 1.0;
      }
    }
  }
  return 0.0;
}
`,
  uniforms(values, ctx, prepared) {
    const v = values as unknown as Values;
    const q = params(v);
    const dv = deriveStipple(q);
    const gl = ctx.gpu.gl;
    const rng = createRng(Number(v.seed) * 6151 + 29);
    const offsets: number[] = [];
    for (let i = 0; i < 4; i++) offsets.push(T + rng() * T, T + rng() * T);
    const dots = Array.from({ length: 4 }, (_, i) => Math.max(1, (v.dotSize as number[])[i] ?? 4, ctx.minDot[i] ?? 0));
    const table = prepared?.table ?? emptyTable;
    return {
      uStPoints: { texture: pointsTexture(gl, prepared?.points ?? emptyPoints()) },
      uStTable: { texture: floatTexture(ctx.gpu, `stipple:${prepared?.key ?? "none"}`, STIPPLE_LEVELS, 1, table) },
      uStDot: dots,
      uStMinFrac: dots.map((d, i) => Math.min(1, (ctx.minDot[i] ?? 0) / d)),
      uStOffset: offsets,
      uStSeed: Number(v.seed) & 0x7fffffff,
      uStShape: q.shape,
      uStReach: Math.min(STIPPLE_MAX_REACH, dv.reach),
      uStSizeVar: q.sizeVar,
      uStToneSize: q.toneSize,
      uStWobble: q.wobble,
      uStRough: q.rough,
      uStDirAngle: q.dirAngle,
      uStDirVar: q.dirVar,
      uStBleed: q.bleed,
      uStGrain: q.grain,
      uStMajor: dv.major,
      uStMinor: dv.minor,
      uStExtent: dv.extent,
    };
  },
});

// Until the worker's point set arrives: no dots (every slot empty = rank 65535).
let empty: Uint8Array | null = null;
const emptyPoints = () => (empty ??= new Uint8Array(T * S * T * 4).fill(255));
const emptyTable = new Float32Array(STIPPLE_LEVELS).fill(-1);
const pointTextures = new WeakMap<Uint8Array, { gl: WebGL2RenderingContext; texture: WebGLTexture }>();

function pointsTexture(gl: WebGL2RenderingContext, data: Uint8Array): WebGLTexture {
  const cached = pointTextures.get(data);
  if (cached && cached.gl === gl) return cached.texture;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T * S, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  pointTextures.set(data, { gl, texture });
  return texture;
}
