// Blue noise threshold map by the void-and-cluster method (Ulichney 1993).
// Every cell of a size × size tile gets a rank; thresholding the ranks at any
// density gives evenly spread, clump-free dots. The tile wraps seamlessly.
//
// Speed: the "tightest cluster" / "largest void" searches use two segment
// trees over the energy field, so each step costs O(kernel + kernel·log N)
// instead of scanning every cell. 256² takes on the order of a second.
//
// DOM-free: runs in a worker.

import { createRng } from "../../util/rng";

/** Segment tree returning the index of the best (max or min) eligible value. */
class ArgTree {
  private size: number;
  private best: Int32Array;

  constructor(
    private values: Float64Array,
    private eligible: (i: number) => boolean,
    private better: (a: number, b: number) => boolean,
  ) {
    let s = 1;
    while (s < values.length) s <<= 1;
    this.size = s;
    this.best = new Int32Array(2 * s).fill(-1);
    for (let i = 0; i < values.length; i++) this.best[s + i] = eligible(i) ? i : -1;
    for (let i = s - 1; i >= 1; i--) this.best[i] = this.pick(this.best[2 * i]!, this.best[2 * i + 1]!);
  }

  private pick(a: number, b: number): number {
    if (a < 0) return b;
    if (b < 0) return a;
    return this.better(this.values[b]!, this.values[a]!) ? b : a;
  }

  update(i: number): void {
    let k = this.size + i;
    this.best[k] = this.eligible(i) ? i : -1;
    for (k >>= 1; k >= 1; k >>= 1) this.best[k] = this.pick(this.best[2 * k]!, this.best[2 * k + 1]!);
  }

  get top(): number {
    return this.best[1]!;
  }
}

export async function voidAndCluster(
  size: number,
  sigma: number,
  yieldNow: () => Promise<void> = async () => {},
  isCancelled: () => boolean = () => false,
): Promise<Float32Array | null> {
  const n = size * size;
  const radius = Math.min(Math.floor(size / 2) - 1, Math.ceil(sigma * 3));
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) });
    }
  }

  const bits = new Uint8Array(n);
  const energy = new Float64Array(n);
  const rank = new Float32Array(n);
  const rng = createRng(0x9e3779b9);

  let ones = 0;
  for (let i = 0; i < n; i++) {
    if (rng() < 0.1) {
      bits[i] = 1;
      ones++;
    }
  }
  if (ones === 0) {
    bits[0] = 1;
    ones = 1;
  }

  let clusterTree: ArgTree;
  let voidTree: ArgTree;
  const rebuildTrees = () => {
    clusterTree = new ArgTree(energy, (i) => bits[i] === 1, (a, b) => a > b);
    voidTree = new ArgTree(energy, (i) => bits[i] === 0, (a, b) => a < b);
  };

  const splat = (i: number, sign: number, updateTrees: boolean) => {
    const x = i % size;
    const y = (i - x) / size;
    for (const { dx, dy, w } of kernel) {
      const j = ((y + dy + size) % size) * size + ((x + dx + size) % size);
      energy[j] = energy[j]! + sign * w;
      if (updateTrees) {
        clusterTree.update(j);
        voidTree.update(j);
      }
    }
  };
  const setBit = (i: number, value: 0 | 1) => {
    bits[i] = value;
    splat(i, value ? 1 : -1, true);
  };

  for (let i = 0; i < n; i++) if (bits[i]) splat(i, 1, false);
  rebuildTrees();

  // 1. Relax the random start into an evenly spread initial pattern.
  for (let iter = 0; iter < n; iter++) {
    const tightest = clusterTree!.top;
    setBit(tightest, 0);
    const largestVoid = voidTree!.top;
    if (largestVoid === tightest) {
      setBit(tightest, 1);
      break;
    }
    setBit(largestVoid, 1);
    if (iter % 1024 === 0) {
      await yieldNow();
      if (isCancelled()) return null;
    }
  }
  const startBits = bits.slice();
  const startEnergy = energy.slice();

  // 2. Rank the initial ones: repeatedly remove the tightest cluster.
  for (let r = ones - 1; r >= 0; r--) {
    const i = clusterTree!.top;
    rank[i] = r;
    setBit(i, 0);
  }

  // 3. From the initial pattern, repeatedly fill the largest void up to full.
  // (Past half full this is the same as removing the tightest cluster of
  // zeros, because the energies of ones and zeros sum to a constant.)
  bits.set(startBits);
  energy.set(startEnergy);
  rebuildTrees();
  for (let r = ones; r < n; r++) {
    const i = voidTree!.top;
    rank[i] = r;
    setBit(i, 1);
    if (r % 1024 === 0) {
      await yieldNow();
      if (isCancelled()) return null;
    }
  }

  for (let i = 0; i < n; i++) rank[i] = (rank[i]! + 0.5) / n;
  return rank;
}

/** Radius (in cells) of round FM dots: large enough that neighbors merge into solid ink. */
export const ROUND_DOT_RADIUS = Math.SQRT1_2;

/**
 * How much of the area round dots actually cover at each density, measured on
 * the map itself (dots overlap, so it isn't simply the density).
 * Returns coverage at densities 0, 1/steps, …, 1.
 */
export function roundDotCoverage(thresholds: Float32Array, size: number, steps = 64, samplesPerAxis = 4): Float32Array {
  const out = new Float32Array(steps + 1);
  const r2 = ROUND_DOT_RADIUS * ROUND_DOT_RADIUS;
  // For every sample point, the lowest threshold among the dots that reach it:
  // the point is inked at density d exactly when that threshold is below d.
  const reach: number[] = [];
  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      for (let sy = 0; sy < samplesPerAxis; sy++) {
        for (let sx = 0; sx < samplesPerAxis; sx++) {
          const qx = cx + (sx + 0.5) / samplesPerAxis;
          const qy = cy + (sy + 0.5) / samplesPerAxis;
          let lowest = 2;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              const fx = qx - (nx + 0.5);
              const fy = qy - (ny + 0.5);
              if (fx * fx + fy * fy > r2) continue;
              const t = thresholds[((ny + size) % size) * size + ((nx + size) % size)]!;
              if (t < lowest) lowest = t;
            }
          }
          reach.push(lowest);
        }
      }
    }
  }
  reach.sort((a, b) => a - b);
  let k = 0;
  for (let i = 0; i <= steps; i++) {
    const d = i / steps;
    while (k < reach.length && reach[k]! < d) k++;
    out[i] = k / reach.length;
  }
  return out;
}
