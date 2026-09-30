// Error diffusion (FM): each cell is set to ink or paper, and the difference
// from the wanted tone is passed on to cells not yet visited, so tones average
// out correctly over an area. DOM-free: runs in a worker.

export type Kernel = "floyd" | "atkinson" | "jarvis" | "stucki";

export interface DiffusionOptions {
  kernel: Kernel;
  /** Alternate the scan direction on every row (reduces directional artifacts). */
  serpentine: boolean;
  /** 0..1: random jitter added to the threshold (breaks up regular patterns). */
  noise: number;
  seed: number;
}

/** [dx, dy, weight] of the neighbors each kernel passes error to (scanning left to right). */
const KERNELS: Record<Kernel, { taps: [number, number, number][]; divisor: number }> = {
  floyd: { taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]], divisor: 16 },
  // Atkinson passes on only 6/8 of the error, which keeps highlights and shadows clean.
  atkinson: { taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], divisor: 8 },
  jarvis: {
    taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
    divisor: 48,
  },
  stucki: {
    taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
    divisor: 42,
  },
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Diffuses each ink independently.
 * @param coverage RGBA bytes, one ink per channel (0 = none, 255 = full), row 0 = top
 * @returns RGBA bytes: 255 where a cell is inked
 */
export function errorDiffuse(coverage: Uint8Array, width: number, height: number, inkCount: number, options: DiffusionOptions): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const { taps, divisor } = KERNELS[options.kernel] ?? KERNELS.floyd;
  // Three rows of error (current + the two below it), padded by 2 on each side.
  const pad = 2;
  const stride = width + pad * 2;
  for (let ink = 0; ink < inkCount; ink++) {
    const rand = rng(options.seed * 7919 + ink * 104729 + 1);
    const rows = [new Float32Array(stride), new Float32Array(stride), new Float32Array(stride)];
    for (let y = 0; y < height; y++) {
      const reverse = options.serpentine && y % 2 === 1;
      const cur = rows[0]!;
      for (let i = 0; i < width; i++) {
        const x = reverse ? width - 1 - i : i;
        const idx = (y * width + x) * 4 + ink;
        const want = coverage[idx]! / 255;
        const v = want + cur[x + pad]!;
        const threshold = 0.5 + (options.noise > 0 ? (rand() - 0.5) * options.noise : 0);
        const on = want > 0 && v >= threshold ? 1 : 0;
        if (on) out[idx] = 255;
        const err = v - on;
        for (const [dx, dy, w] of taps) {
          const tx = x + (reverse ? -dx : dx) + pad;
          rows[dy]![tx] = rows[dy]![tx]! + (err * w) / divisor;
        }
      }
      // Shift the error rows up one.
      const done = rows.shift()!;
      done.fill(0);
      rows.push(done);
    }
  }
  return out;
}
