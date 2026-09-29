// FM halftone, blue noise density: dots of a fixed size, more of them in darker
// areas. Placement comes from a void-and-cluster threshold map (built in a
// worker, cached): a dot cell is inked when its threshold is below the tone,
// which spreads dots evenly without clumps. Each ink reads the map at its own
// offset (from the seed), so layers are placed independently.

import { defineSection } from "../../schema/types";
import type { BlueNoiseRequest, BlueNoiseResult } from "../../workers/blueNoiseTypes";
import { WorkerClient } from "../../workers/workerClient";
import { createRng } from "../../util/rng";
import { ROUND_DOT_RADIUS } from "../../engine/halftone/voidAndCluster";
import { defineHalftoneMethod } from "./types";

export const fmBlueNoiseSection = defineSection({
  id: "halftoneFm",
  title: "FM: blue noise",
  stage: "halftone",
  parent: "halftone",
  description: "Same-size dots, more of them in darker areas, spread evenly without clumps.",
  visibleWhen: (s) => s.halftone?.type === "fm",
  settings: [
    {
      kind: "number",
      key: "dotSize",
      label: "Dot size",
      perInk: true,
      default: 2,
      min: 1,
      max: 12,
      step: 0.5,
      unit: "px",
      help: "In output pixels. Never smaller than the minimum dot size.",
    },
    {
      kind: "select",
      key: "shape",
      label: "Dot shape",
      default: "round",
      display: "segmented",
      options: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
      ],
    },
    { kind: "number", key: "minDensity", label: "Minimum density", default: 0, min: 0, max: 100, step: 1, unit: "%" },
    { kind: "number", key: "maxDensity", label: "Maximum density", default: 100, min: 0, max: 100, step: 1, unit: "%" },
    {
      kind: "select",
      key: "mapSize",
      label: "Threshold map size",
      default: "128",
      display: "segmented",
      options: [
        { value: "64", label: "64" },
        { value: "128", label: "128" },
        { value: "256", label: "256" },
      ],
      help: "Larger maps repeat less visibly but take longer to build (once, then cached).",
    },
    {
      kind: "number",
      key: "spread",
      label: "Filter spread",
      default: 1.9,
      min: 1,
      max: 3,
      step: 0.1,
      help: "How far apart dots push each other while the map is built. Higher = smoother, more even spacing.",
    },
    { kind: "seed", key: "seed", label: "Random seed", default: 1 },
  ],
});

let client: WorkerClient<BlueNoiseRequest, BlueNoiseResult> | null = null;
const maps = new Map<string, Promise<BlueNoiseResult>>();

function thresholdMap(size: number, sigma: number): Promise<BlueNoiseResult> {
  const key = `${size}|${sigma}`;
  let map = maps.get(key);
  if (!map) {
    client ??= new WorkerClient(new Worker(new URL("../../workers/blueNoise.worker.ts", import.meta.url), { type: "module" }));
    map = client.run({ size, sigma });
    // Don't cache failures (e.g. superseded by a newer request).
    map.catch(() => maps.delete(key));
    maps.set(key, map);
  }
  return map;
}

const mapTextures = new WeakMap<BlueNoiseResult, { gl: WebGL2RenderingContext; texture: WebGLTexture }>();

function mapTexture(gl: WebGL2RenderingContext, map: BlueNoiseResult): WebGLTexture {
  const cached = mapTextures.get(map);
  if (cached && cached.gl === gl) return cached.texture;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, map.size, map.size, 0, gl.RED, gl.FLOAT, map.thresholds);
  mapTextures.set(map, { gl, texture });
  return texture;
}

export const fmBlueNoise = defineHalftoneMethod({
  id: "fm",
  label: "FM: blue noise",
  section: fmBlueNoiseSection,
  prepareKey: (values) => `${values.mapSize}|${values.spread}`,
  prepare: (values) => thresholdMap(Number(values.mapSize), values.spread),
  glsl: /* glsl */ `
uniform sampler2D uFmMap;   // thresholds 0..1, read with texelFetch
uniform int uFmMapSize;
uniform vec4 uFmDot;        // dot size per ink, output px
uniform vec2 uFmOffset[4];  // per-ink offset into the map (cells)
uniform float uFmMin;
uniform float uFmMax;
uniform int uFmRound;
uniform sampler2D uFmRoundDensity; // tone → density that gives that tone with round dots

vec2 htSamplePoint(int ink, vec2 p) {
  float d = uFmDot[ink];
  return (floor(p / d) + 0.5) * d;
}

// Is there a dot in this cell? (Its threshold is below the tone at the cell's center.)
float fmCellOn(int ink, vec2 cell) {
  float d = uFmDot[ink];
  float c = htCoverage(ink, (cell + 0.5) * d);
  if (c <= 0.004) return 0.0;
  float density = mix(uFmMin, uFmMax, clamp(c, 0.0, 1.0));
  // Round dots overlap, so fewer of them are needed for the same tone.
  if (uFmRound == 1) density = texture(uFmRoundDensity, vec2((density * 255.0 + 0.5) / 256.0, 0.5)).r;
  ivec2 idx = ivec2(mod(cell + uFmOffset[ink], float(uFmMapSize)));
  return texelFetch(uFmMap, idx, 0).r < density ? 1.0 : 0.0;
}

float htInk(int ink, vec2 p, float c) {
  vec2 q = p / uFmDot[ink];
  if (uFmRound == 0) return fmCellOn(ink, floor(q));
  // Round dots are big enough that neighbors merge into solid ink, so they
  // reach into surrounding cells: check the 3×3 cells around p.
  vec2 home = floor(q);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = home + vec2(float(i), float(j));
      vec2 f = q - (cell + 0.5);
      if (dot(f, f) <= ${(ROUND_DOT_RADIUS * ROUND_DOT_RADIUS).toFixed(4)} && fmCellOn(ink, cell) > 0.5) return 1.0;
    }
  }
  return 0.0;
}
`,
  uniforms(values, ctx, map) {
    const size = map?.size ?? 1;
    const rng = createRng(values.seed * 7919 + 17);
    const offsets: number[] = [];
    for (let i = 0; i < 4; i++) offsets.push(Math.floor(rng() * size), Math.floor(rng() * size));
    return {
      uFmMap: { texture: map ? mapTexture(ctx.gpu.gl, map) : emptyTexture(ctx.gpu.gl) },
      uFmMapSize: size,
      uFmDot: Array.from({ length: 4 }, (_, i) => Math.max(1, values.dotSize[i] ?? 2, ctx.minDot[i] ?? 0)),
      uFmOffset: offsets,
      uFmMin: values.minDensity / 100,
      uFmMax: values.maxDensity / 100,
      uFmRound: values.shape === "round" ? 1 : 0,
      uFmRoundDensity: { texture: map ? roundDensityTexture(ctx.gpu.gl, map) : emptyTexture(ctx.gpu.gl) },
    };
  },
});

const densityTextures = new WeakMap<BlueNoiseResult, { gl: WebGL2RenderingContext; texture: WebGLTexture }>();

/** Inverts the measured round-dot coverage: for each tone, the density that produces it. */
function roundDensityTexture(gl: WebGL2RenderingContext, map: BlueNoiseResult): WebGLTexture {
  const cached = densityTextures.get(map);
  if (cached && cached.gl === gl) return cached.texture;
  const cov = map.roundCoverage;
  const steps = cov.length - 1;
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const target = i / 255;
    let k = 0;
    while (k < steps && cov[k + 1]! < target) k++;
    const c0 = cov[k]!;
    const c1 = cov[Math.min(steps, k + 1)]!;
    const t = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    out[i] = Math.min(1, (k + Math.min(1, Math.max(0, t))) / steps);
  }
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, out);
  densityTextures.set(map, { gl, texture });
  return texture;
}

const empties = new WeakMap<WebGL2RenderingContext, WebGLTexture>();
function emptyTexture(gl: WebGL2RenderingContext): WebGLTexture {
  let t = empties.get(gl);
  if (!t) {
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([1]));
    empties.set(gl, t);
  }
  return t;
}
