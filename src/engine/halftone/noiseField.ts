// Nudge fields for the AM noise grid: for each grid cell, how far its dot is
// moved from the cell center (x and y, in cells, within ±0.5).
//
// The field is large (1024 × 1024 cells, wrapping) so it never visibly
// repeats: at 8 px spacing it spans 8192 px.
// - Blue: white noise minus its blur, so neighboring nudges differ sharply.
// - Pink: smooth noise summed over every scale from 2 to 256 cells with equal
//   power per octave (1/f), so there are waves of all sizes and no fixed one.
// - Green: a smooth random "height" field with hills about one cluster size
//   apart; every dot moves uphill, so dots gather on the hilltops. The hills
//   are random in place, size and shape, so the clusters are too.
// Blue and pink are then rank-equalized, so every noise kind nudges by the
// same amounts and only the spatial pattern differs.

import { createRng } from "../../util/rng";

export const NOISE_FIELD_SIZE = 1024;

export type NoiseKind = "blue" | "pink" | "green";

/** Returns N × N × 2 bytes: x then y nudge per cell, stored as round((nudge + 0.5) × 255). */
export function buildNoiseField(kind: NoiseKind, cluster: number, seed: number): Uint8Array {
  const N = NOISE_FIELD_SIZE;
  const rng = createRng(seed * 977 + 13);
  let ox: Float32Array;
  let oy: Float32Array;
  if (kind === "green") {
    [ox, oy] = greenField(N, Math.max(2, cluster), rng);
  } else {
    const make = kind === "blue" ? () => blueChannel(N, rng) : () => pinkChannel(N, rng);
    ox = equalize(make());
    oy = equalize(make());
  }
  const out = new Uint8Array(N * N * 2);
  for (let i = 0; i < N * N; i++) {
    out[i * 2] = Math.round((clampHalf(ox[i]!) + 0.5) * 255);
    out[i * 2 + 1] = Math.round((clampHalf(oy[i]!) + 0.5) * 255);
  }
  return out;
}

const clampHalf = (v: number) => Math.max(-0.5, Math.min(0.5, v));

function whiteNoise(n: number, rng: () => number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rng() - 0.5;
  return a;
}

/** Separable Gaussian blur on a wrapping N × N field. */
function blur(src: Float32Array, N: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ksum = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(N * N);
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += k[d + r]! * src[y * N + ((x + d + N) % N)]!;
      tmp[y * N + x] = s / ksum;
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += k[d + r]! * tmp[((y + d + N) % N) * N + x]!;
      out[y * N + x] = s / ksum;
    }
  }
  return out;
}

function blueChannel(N: number, rng: () => number): Float32Array {
  const w = whiteNoise(N * N, rng);
  const low = blur(w, N, 1);
  for (let i = 0; i < w.length; i++) w[i] = w[i]! - low[i]!;
  return w;
}

/** Smooth (cubic-interpolated) wrapping noise with features every `scale` cells. */
function addOctave(out: Float32Array, N: number, scale: number, rng: () => number): void {
  const g = N / scale;
  const grid = whiteNoise(g * g, rng);
  // Normalize each octave to unit variance so every octave carries equal power.
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const tmp = new Float32Array(N * N);
  let sum2 = 0;
  for (let y = 0; y < N; y++) {
    const gy = y / scale;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    const r0 = (y0 % g) * g;
    const r1 = ((y0 + 1) % g) * g;
    for (let x = 0; x < N; x++) {
      const gx = x / scale;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const c0 = x0 % g;
      const c1 = (x0 + 1) % g;
      const a = grid[r0 + c0]! + (grid[r0 + c1]! - grid[r0 + c0]!) * tx;
      const b = grid[r1 + c0]! + (grid[r1 + c1]! - grid[r1 + c0]!) * tx;
      const v = a + (b - a) * ty;
      tmp[y * N + x] = v;
      sum2 += v * v;
    }
  }
  const norm = 1 / Math.sqrt(sum2 / (N * N) || 1);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + tmp[i]! * norm;
}

function pinkChannel(N: number, rng: () => number): Float32Array {
  const out = new Float32Array(N * N);
  for (let scale = 2; scale <= 256; scale *= 2) addOctave(out, N, scale, rng);
  return out;
}

/** Maps values to their rank, spread evenly over -0.5…0.5. */
function equalize(v: Float32Array): Float32Array {
  const sorted = v.slice().sort();
  const n = v.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = n - 1;
    const x = v[i]!;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    out[i] = (lo + 0.5) / n - 0.5;
  }
  return out;
}

/** Dots pushed up the slope of a smooth random field, so they gather at its peaks. */
function greenField(N: number, cluster: number, rng: () => number): [Float32Array, Float32Array] {
  // A Gaussian blur of white noise with sigma ≈ cluster / 2.5 has peaks about `cluster` cells apart.
  const h = blur(whiteNoise(N * N, rng), N, Math.max(0.8, cluster / 2.5));
  const ox = new Float32Array(N * N);
  const oy = new Float32Array(N * N);
  let sum2 = 0;
  for (let y = 0; y < N; y++) {
    const up = ((y + N - 1) % N) * N;
    const down = ((y + 1) % N) * N;
    for (let x = 0; x < N; x++) {
      const gx = h[y * N + ((x + 1) % N)]! - h[y * N + ((x + N - 1) % N)]!;
      const gy = h[down + x]! - h[up + x]!;
      ox[y * N + x] = gx;
      oy[y * N + x] = gy;
      sum2 += gx * gx + gy * gy;
    }
  }
  // Typical move: 0.7 cells toward the nearest hilltop (so most dots reach
  // the cell edge), plus a little jitter. The move's length is clamped to 0.5,
  // not x and y separately, so clusters come out round rather than square.
  const scale = 0.7 / Math.sqrt(sum2 / (N * N) || 1);
  for (let i = 0; i < N * N; i++) {
    let dx = ox[i]! * scale + (rng() - 0.5) * 0.15;
    let dy = oy[i]! * scale + (rng() - 0.5) * 0.15;
    const len = Math.hypot(dx, dy);
    if (len > 0.5) {
      dx *= 0.5 / len;
      dy *= 0.5 / len;
    }
    ox[i] = dx;
    oy[i] = dy;
  }
  return [ox, oy];
}
