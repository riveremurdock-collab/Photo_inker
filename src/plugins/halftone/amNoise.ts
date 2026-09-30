// AM halftone on a noise grid: one dot per cell of a square grid, each
// nudged away from the cell center by a noise pattern, so the regular grid
// look (and moiré) breaks up while dot size still carries the tone.
// - Blue noise: nudges differ sharply between neighbors (even, grainy).
// - Pink noise: neighboring nudges are similar (wavy rows).
// - Green noise: dots gather into clusters of a chosen size (clumpy).
// The nudge pattern is a 64 × 64 tile that repeats; each ink reads it at its
// own offset (from the seed), so layers are placed independently.

import { voidAndCluster } from "../../engine/halftone/voidAndCluster";
import { defineSection } from "../../schema/types";
import { createRng } from "../../util/rng";
import { floatTexture, GLSL_LATTICE, GLSL_LATTICE_HT, latticeDotSettings, latticeUniforms, measureThresholds, type LatticeShape } from "./lattice";
import { defineHalftoneMethod } from "./types";

const TILE = 64;

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
  /** TILE × TILE × 4 floats: x and y nudge per cell (lattice units), then two unused. */
  data: Float32Array;
}

let blueRanks: Float32Array | null = null;

/** Builds the nudge tile for the settings. */
async function buildTile(noise: string, amount: number, cluster: number, seed: number): Promise<NoiseTile> {
  const rng = createRng(seed * 977 + 13);
  const n = TILE * TILE;
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  if (noise === "blue") {
    blueRanks ??= await voidAndCluster(TILE, 1.5);
    // Two unrelated places in the same blue noise map give independent x and y nudges.
    const sx = Math.floor(rng() * TILE);
    const sy = Math.floor(rng() * TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        ox[y * TILE + x] = blueRanks![((y + sy) % TILE) * TILE + ((x + sx) % TILE)]! - 0.5;
        oy[y * TILE + x] = blueRanks![((y + sy + 32) % TILE) * TILE + ((x + sx + 21) % TILE)]! - 0.5;
      }
    }
  } else if (noise === "pink") {
    // White noise, blurred (wrapping around the tile), then scaled to ±0.5.
    const wx = Float32Array.from({ length: n }, () => rng() - 0.5);
    const wy = Float32Array.from({ length: n }, () => rng() - 0.5);
    const blur = (src: Float32Array, out: Float32Array) => {
      const r = 3;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          let s = 0;
          let w = 0;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const k = Math.exp(-(dx * dx + dy * dy) / 4.5);
              s += k * src[((y + dy + TILE) % TILE) * TILE + ((x + dx + TILE) % TILE)]!;
              w += k;
            }
          }
          out[y * TILE + x] = s / w;
        }
      }
      let max = 1e-6;
      for (const v of out) max = Math.max(max, Math.abs(v));
      for (let i = 0; i < n; i++) out[i] = (out[i]! / max) * 0.5;
    };
    blur(wx, ox);
    blur(wy, oy);
  } else {
    // Green: pull each dot toward the center of its cluster of cells.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const cx = (Math.floor(x / cluster) + 0.5) * cluster - 0.5;
        const cy = (Math.floor(y / cluster) + 0.5) * cluster - 0.5;
        ox[y * TILE + x] = Math.max(-0.5, Math.min(0.5, (cx - x) * 0.45 + (rng() - 0.5) * 0.2));
        oy[y * TILE + x] = Math.max(-0.5, Math.min(0.5, (cy - y) * 0.45 + (rng() - 0.5) * 0.2));
      }
    }
  }
  const data = new Float32Array(n * 4);
  const a = amount / 100;
  for (let i = 0; i < n; i++) {
    data[i * 4] = ox[i]! * a;
    data[i * 4 + 1] = oy[i]! * a;
  }
  return { key: `${noise}|${amount}|${cluster}|${seed}`, data };
}

function nearestIn(tile: Float32Array) {
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
        const px = cx + 0.5 + tile[i * 4]!;
        const py = cy + 0.5 + tile[i * 4 + 1]!;
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
  prepareKey: (values) => `${values.noise}|${values.amount}|${values.cluster}|${values.seed}`,
  prepare: (values) => buildTile(String(values.noise), Number(values.amount), Number(values.cluster), Number(values.seed)),
  glsl: /* glsl */ `
${GLSL_LATTICE}
uniform sampler2D uNoiseTile;   // ${TILE} × ${TILE}, xy = nudge per cell
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
      vec2 o = texelFetch(uNoiseTile, ivec2(mod(cell, ${TILE}.0)), 0).xy;
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
    const data = tile?.data ?? new Float32Array(TILE * TILE * 4);
    const key = tile?.key ?? "none";
    const rng = createRng(Number(values.seed) * 31 + 7);
    const shift: number[] = [];
    for (let i = 0; i < 4; i++) shift.push(Math.floor(rng() * TILE), Math.floor(rng() * TILE));
    return {
      ...latticeUniforms(values as never, ctx, "cellSize", null, {
        key: `noise:${key}`,
        measure: () => measureThresholds(nearestIn(data), (values as unknown as { shape: LatticeShape }).shape, (r) => [r() * TILE, r() * TILE]),
      }),
      uNoiseTile: { texture: floatTexture(ctx.gpu, `noiseTile:${key}`, TILE, TILE, data, 4) },
      uNoiseShift: shift,
    };
  },
});
