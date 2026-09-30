// AM halftone on a noise grid: one dot per cell of a square grid, each
// nudged away from the cell center by a noise pattern, so the regular grid
// look (and moiré) breaks up while dot size still carries the tone.
// - Blue noise: nudges differ sharply between neighbors (even, grainy).
// - Pink noise: neighboring nudges are similar (wavy rows).
// - Green noise: dots gather into clusters of a chosen size (clumpy).
// The nudge field (engine/halftone/noiseField.ts) is 1024 × 1024 cells, built
// in a worker, so it never visibly repeats; each ink reads it at its own
// offset (from the seed), so layers are placed independently. The noise
// amount only scales the nudges in the shader, so changing it is instant.

import { NOISE_FIELD_SIZE, type NoiseKind } from "../../engine/halftone/noiseField";
import { defineSection } from "../../schema/types";
import { createRng } from "../../util/rng";
import { halftoneWorker } from "./halftoneWorker";
import { GLSL_LATTICE, GLSL_LATTICE_HT, latticeDotSettings, latticeUniforms, measureThresholds, type LatticeShape } from "./lattice";
import { defineHalftoneMethod } from "./types";

const TILE = NOISE_FIELD_SIZE;

export const amNoiseSection = defineSection({
  id: "halftoneNoise",
  title: "AM: noise grid",
  stage: "halftone",
  parent: "halftone",
  description: "A grid with each dot nudged by noise: breaks up the regular pattern and moiré while keeping dot-size shading.",
  visibleWhen: (s) => s.halftone?.type === "noise",
  settings: [
    {
      kind: "select",
      key: "noise",
      label: "Noise",
      default: "blue",
      display: "segmented",
      options: [
        { value: "blue", label: "Blue" },
        { value: "pink", label: "Pink" },
        { value: "green", label: "Green" },
      ],
    },
    { kind: "number", key: "cellSize", label: "Grid spacing", perInk: true, default: 8, min: 2, max: 64, step: 0.5, unit: "px" },
    { kind: "number", key: "amount", label: "Noise amount", default: 70, min: 0, max: 100, step: 1, unit: "%" },
    {
      kind: "number",
      key: "cluster",
      label: "Cluster size",
      default: 3,
      min: 2,
      max: 8,
      step: 1,
      unit: "cells",
      visibleWhen: (s) => s.noise === "green",
    },
    { kind: "seed", key: "seed", label: "Random seed", default: 1 },
    ...latticeDotSettings(),
  ],
});

interface NoiseTile {
  key: string;
  /** TILE × TILE × 2 bytes: x and y nudge per cell, round((nudge + 0.5) × 255). */
  data: Uint8Array;
}

const nudge = (v: number) => v / 255 - 0.5;

function nearestIn(tile: Uint8Array, amount: number) {
  return (x: number, y: number): [number, number] => {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    let best: [number, number] = [0, 0];
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = bx + dx;
        const cy = by + dy;
        const i = (((cy % TILE) + TILE) % TILE) * TILE + (((cx % TILE) + TILE) % TILE);
        const px = cx + 0.5 + nudge(tile[i * 2]!) * amount;
        const py = cy + 0.5 + nudge(tile[i * 2 + 1]!) * amount;
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [px, py];
        }
      }
    }
    return best;
  };
}

export const amNoise = defineHalftoneMethod({
  id: "noise",
  label: "AM: noise grid",
  section: amNoiseSection,
  prepareKey: (values) => tileKey(values as never),
  async prepare(values): Promise<NoiseTile> {
    const result = await halftoneWorker("noise").run({
      kind: "noiseField",
      noise: String(values.noise) as NoiseKind,
      cluster: Number(values.cluster),
      seed: Number(values.seed),
    });
    if (result.kind !== "noiseField") throw new Error("unexpected worker result");
    return { key: tileKey(values as never), data: result.data };
  },
  glsl: /* glsl */ `
${GLSL_LATTICE}
uniform sampler2D uNoiseTile;   // ${TILE} × ${TILE}, RG8: nudge per cell + 0.5
uniform float uNoiseAmount;
uniform vec2 uNoiseShift[4];    // per-ink offset into the tile (cells)
vec2 latToLattice(int ink, vec2 p) { return p / uLatSize[ink] + uNoiseShift[ink]; }
vec2 latFromLattice(int ink, vec2 q) { return (q - uNoiseShift[ink]) * uLatSize[ink]; }
vec2 latNearest(int ink, vec2 q) {
  vec2 b = floor(q);
  vec2 best = vec2(0.0);
  float bestD = 1e9;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = b + vec2(float(dx), float(dy));
      vec2 o = (texelFetch(uNoiseTile, ivec2(mod(cell, ${TILE}.0)), 0).xy - 0.5) * uNoiseAmount;
      vec2 c = cell + 0.5 + o;
      float d = dot(q - c, q - c);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  return best;
}
${GLSL_LATTICE_HT}
`,
  uniforms(values, ctx, tile) {
    const data = tile?.data ?? emptyTile;
    const key = tile?.key ?? "none";
    const amount = Number(values.amount) / 100;
    const rng = createRng(Number(values.seed) * 31 + 7);
    const shift: number[] = [];
    for (let i = 0; i < 4; i++) shift.push(Math.floor(rng() * TILE), Math.floor(rng() * TILE));
    return {
      ...latticeUniforms(values as never, ctx, "cellSize", null, {
        key: `noise:${key}|${amount}`,
        measure: () => measureThresholds(nearestIn(data, amount), (values as unknown as { shape: LatticeShape }).shape, (r) => [r() * TILE, r() * TILE]),
      }),
      uNoiseTile: { texture: tileTexture(ctx.gpu.gl, data) },
      uNoiseAmount: amount,
      uNoiseShift: shift,
    };
  },
});

function tileKey(values: { noise: unknown; cluster: unknown; seed: unknown }): string {
  // Cluster size only matters for green noise.
  return `${values.noise}|${values.noise === "green" ? values.cluster : 0}|${values.seed}`;
}

/** Neutral field (no nudges) until the worker's field arrives. */
const emptyTile = new Uint8Array(TILE * TILE * 2).fill(128);
const tileTextures = new WeakMap<Uint8Array, WebGLTexture>();

function tileTexture(gl: WebGL2RenderingContext, data: Uint8Array): WebGLTexture {
  let texture = tileTextures.get(data);
  if (texture) return texture;
  texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, TILE, TILE, 0, gl.RG, gl.UNSIGNED_BYTE, data);
  tileTextures.set(data, texture);
  return texture;
}
