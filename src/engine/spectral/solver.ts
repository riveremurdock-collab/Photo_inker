// Ink Matching solver. For a color, finds how much of each ink (0..1)
// best reproduces it, using the same ink model as the preview (Demichel mix of
// the spectral overlap table) and a perceptual (Lab) color difference.
//
// Solving every pixel would be slow, so the solver fills a 3D lookup table
// over sRGB (size³ entries); the GPU then looks every pixel up with trilinear
// interpolation. Entries are solved in scan order, each starting from its
// neighbor's answer, which keeps the table smooth (no banding or flicker
// between neighboring colors).
//
// Runs in a worker: DOM-free.

export interface SolveOptions {
  inkCount: number;
  /** Overlap table colors, linear RGB, 2ⁿ × 3. */
  table: Float32Array;
  /** Per ink, 0..1. Higher = used first when several mixes would work. */
  priority: number[];
  /** 0..1: prefer fewer inks per pixel (less overlap, cleaner color). */
  sparsity: number;
  /** 0..1: 0 = keep lightness exact, 1 = keep hue exact. */
  balance: number;
  /** Compress the image's lightness range into what the inks can reach, instead of clipping. */
  compress: boolean;
}

// Weights (in ΔE units at full coverage) for the soft preferences.
const PRIORITY_WEIGHT = 6;
const OVERLAP_WEIGHT = 22;
const INK_AMOUNT_WEIGHT = 4;

const WHITE_X = 0.95047;
const WHITE_Z = 1.08883;

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

class Model {
  readonly n: number;
  private combos: number;
  readonly m: number; // residual count
  private sL: number;
  private sAB: number;
  private pri: Float64Array;
  private overlap: number;
  readonly lab = new Float64Array(3);

  constructor(private opts: SolveOptions) {
    this.n = opts.inkCount;
    this.combos = 1 << this.n;
    this.m = 3 + this.n + (this.n * (this.n - 1)) / 2;
    const t = Math.min(1, Math.max(0, opts.balance));
    this.sL = 1.6 - t;
    this.sAB = 0.6 + t;
    this.pri = Float64Array.from({ length: this.n }, (_, i) => PRIORITY_WEIGHT * (1 - (opts.priority[i] ?? 0.5)) + INK_AMOUNT_WEIGHT * opts.sparsity * 0.25);
    this.overlap = OVERLAP_WEIGHT * opts.sparsity;
  }

  /** Lab of the ink mix with coverage c (written to this.lab). */
  forwardLab(c: ArrayLike<number>): Float64Array {
    const n = this.n;
    const t = this.opts.table;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let mask = 0; mask < this.combos; mask++) {
      let w = 1;
      for (let i = 0; i < n; i++) w *= mask & (1 << i) ? c[i]! : 1 - c[i]!;
      r += w * t[mask * 3]!;
      g += w * t[mask * 3 + 1]!;
      b += w * t[mask * 3 + 2]!;
    }
    return linearToLabInto(r, g, b, this.lab);
  }

  /** Residual vector: weighted Lab error, then per-ink preference terms, then pairwise overlap terms. */
  residual(c: ArrayLike<number>, target: Float64Array, out: Float64Array): number {
    const lab = this.forwardLab(c);
    out[0] = this.sL * (lab[0]! - target[0]!);
    out[1] = this.sAB * (lab[1]! - target[1]!);
    out[2] = this.sAB * (lab[2]! - target[2]!);
    let k = 3;
    for (let i = 0; i < this.n; i++) out[k++] = this.pri[i]! * c[i]!;
    for (let i = 0; i < this.n; i++) {
      for (let j = i + 1; j < this.n; j++) out[k++] = this.overlap * c[i]! * c[j]!;
    }
    let cost = 0;
    for (let i = 0; i < this.m; i++) cost += out[i]! * out[i]!;
    return cost;
  }
}

function linearToLabInto(r: number, g: number, b: number, out: Float64Array): Float64Array {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const fx = labF(x / WHITE_X);
  const fy = labF(y);
  const fz = labF(z / WHITE_Z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

/** Solves A x = b in place for a small n×n system (Gaussian elimination with pivoting). */
function solveSmall(a: Float64Array, b: Float64Array, n: number): boolean {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = r;
    if (Math.abs(a[pivot * n + col]!) < 1e-12) return false;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = a[col * n + k]!;
        a[col * n + k] = a[pivot * n + k]!;
        a[pivot * n + k] = tmp;
      }
      const tb = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / a[col * n + col]!;
      for (let k = col; k < n; k++) a[r * n + k] = a[r * n + k]! - f * a[col * n + k]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= a[r * n + k]! * b[k]!;
    b[r] = s / a[r * n + r]!;
  }
  return true;
}

/** Box-constrained Levenberg–Marquardt from a starting coverage. Returns the final cost; c is updated in place. */
function refine(model: Model, target: Float64Array, c: Float64Array, scratch: Scratch): number {
  const { n, m } = model;
  const { r, rTry, j, jtj, jtr, cTry, cStep } = scratch;
  let cost = model.residual(c, target, r);
  let mu = 1e-3;
  const h = 1e-3;
  for (let iter = 0; iter < 16; iter++) {
    // Numeric Jacobian (one-sided, stepping inward at the box edge).
    for (let i = 0; i < n; i++) {
      cStep.set(c);
      const step = c[i]! + h <= 1 ? h : -h;
      cStep[i] = c[i]! + step;
      model.residual(cStep, target, rTry);
      for (let k = 0; k < m; k++) j[k * n + i] = (rTry[k]! - r[k]!) / step;
    }
    for (let a = 0; a < n; a++) {
      let g = 0;
      for (let k = 0; k < m; k++) g += j[k * n + a]! * r[k]!;
      jtr[a] = g;
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += j[k * n + a]! * j[k * n + b]!;
        jtj[a * n + b] = s;
      }
    }

    let improved = false;
    while (mu < 1e8) {
      const A = scratch.a;
      const B = scratch.b;
      for (let k = 0; k < n * n; k++) A[k] = jtj[k]!;
      for (let a = 0; a < n; a++) {
        A[a * n + a] = A[a * n + a]! * (1 + mu) + 1e-9;
        B[a] = -jtr[a]!;
      }
      if (!solveSmall(A, B, n)) {
        mu *= 10;
        continue;
      }
      for (let a = 0; a < n; a++) cTry[a] = Math.min(1, Math.max(0, c[a]! + B[a]!));
      const tryCost = model.residual(cTry, target, rTry);
      if (tryCost < cost) {
        const gain = cost - tryCost;
        c.set(cTry);
        r.set(rTry);
        cost = tryCost;
        mu = Math.max(1e-7, mu * 0.3);
        improved = gain > 1e-4;
        break;
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  return cost;
}

interface Scratch {
  r: Float64Array;
  rTry: Float64Array;
  j: Float64Array;
  jtj: Float64Array;
  jtr: Float64Array;
  cTry: Float64Array;
  cStep: Float64Array;
  a: Float64Array;
  b: Float64Array;
}

function makeScratch(n: number, m: number): Scratch {
  return {
    r: new Float64Array(m),
    rTry: new Float64Array(m),
    j: new Float64Array(m * n),
    jtj: new Float64Array(n * n),
    jtr: new Float64Array(n),
    cTry: new Float64Array(n),
    cStep: new Float64Array(n),
    a: new Float64Array(n * n),
    b: new Float64Array(n),
  };
}

/**
 * Builds the lookup table. Returns size³ × 4 bytes (RGBA, one ink per channel;
 * index = ((b * size + g) * size + r) * 4 over sRGB grid values), or null if
 * cancelled. `yieldNow` is awaited between slices so a newer request can cancel.
 */
export async function buildInkLut(
  opts: SolveOptions,
  size: number,
  isCancelled: () => boolean,
  yieldNow: () => Promise<void>,
): Promise<Uint8Array | null> {
  const n = opts.inkCount;
  const out = new Uint8Array(size * size * size * 4);
  if (n === 0) return out;
  const solved = new Float32Array(size * size * size * n);
  const model = new Model(opts);
  const scratch = makeScratch(n, model.m);

  // Lightness range the inks can reach (paper = lightest, darkest overlap = darkest).
  const tmpLab = new Float64Array(3);
  let lMax = -Infinity;
  let lMin = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    linearToLabInto(opts.table[mask * 3]!, opts.table[mask * 3 + 1]!, opts.table[mask * 3 + 2]!, tmpLab);
    lMax = Math.max(lMax, tmpLab[0]!);
    lMin = Math.min(lMin, tmpLab[0]!);
  }

  // Coarse candidate grid, used as a second starting point so a far-away
  // better mix (e.g. black ink instead of a CMY build) isn't missed.
  const levels = [0, 1 / 3, 2 / 3, 1];
  const candCount = levels.length ** n;
  const candCoverage = new Float64Array(candCount * n);
  const candLab = new Float64Array(candCount * 3);
  const candPenalty = new Float64Array(candCount);
  const zeroTarget = new Float64Array(3);
  const rTmp = new Float64Array(model.m);
  for (let k = 0; k < candCount; k++) {
    let v = k;
    for (let i = 0; i < n; i++) {
      candCoverage[k * n + i] = levels[v % levels.length]!;
      v = Math.floor(v / levels.length);
    }
    const c = candCoverage.subarray(k * n, k * n + n);
    const lab = model.forwardLab(c);
    candLab.set(lab, k * 3);
    model.residual(c, zeroTarget, rTmp);
    let pen = 0;
    for (let q = 3; q < model.m; q++) pen += rTmp[q]! * rTmp[q]!;
    candPenalty[k] = pen;
  }
  const sL = 1.6 - Math.min(1, Math.max(0, opts.balance));
  const sAB = 0.6 + Math.min(1, Math.max(0, opts.balance));

  const target = new Float64Array(3);
  const warm = new Float64Array(n);
  const rowStart = new Float64Array(n);
  const c = new Float64Array(n);
  const c2 = new Float64Array(n);
  let haveWarm = false;

  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        linearToLabInto(
          srgbToLinear(ri / (size - 1)),
          srgbToLinear(gi / (size - 1)),
          srgbToLinear(bi / (size - 1)),
          target,
        );
        if (opts.compress) target[0] = lMin + (target[0]! / 100) * (lMax - lMin);

        // Start A: the neighbor's answer.
        if (ri === 0) warm.set(haveWarm ? rowStart : warm);
        c.set(warm);
        let cost = haveWarm ? refine(model, target, c, scratch) : Infinity;

        // Start B: the best coarse candidate, refined only if it looks better.
        let best = 0;
        let bestCost = Infinity;
        for (let k = 0; k < candCount; k++) {
          const dl = sL * (candLab[k * 3]! - target[0]!);
          const da = sAB * (candLab[k * 3 + 1]! - target[1]!);
          const db = sAB * (candLab[k * 3 + 2]! - target[2]!);
          const cc = dl * dl + da * da + db * db + candPenalty[k]!;
          if (cc < bestCost) {
            bestCost = cc;
            best = k;
          }
        }
        if (bestCost < cost) {
          c2.set(candCoverage.subarray(best * n, best * n + n));
          const cost2 = refine(model, target, c2, scratch);
          if (cost2 < cost) {
            c.set(c2);
            cost = cost2;
          }
        }

        warm.set(c);
        if (ri === 0) rowStart.set(c);
        haveWarm = true;
        solved.set(c, ((bi * size + gi) * size + ri) * n);
      }
    }
    await yieldNow();
    if (isCancelled()) return null;
  }

  // Where two ink mixes match a color about equally well, neighboring entries
  // can flip between them, which would show as jagged edges after
  // interpolation. A light blur along each axis makes such switches gradual.
  smoothLut(solved, size, n);
  for (let k = 0; k < size * size * size; k++) {
    for (let i = 0; i < n; i++) out[k * 4 + i] = Math.round(Math.min(1, Math.max(0, solved[k * n + i]!)) * 255);
  }
  return out;
}

/** [1, 2, 1] / 4 blur along r, g, and b, in place (edges clamped). */
function smoothLut(data: Float32Array, size: number, n: number): void {
  const tmp = new Float32Array(data.length);
  const strides = [n, size * n, size * size * n];
  for (const stride of strides) {
    tmp.set(data);
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const base = ((b * size + g) * size + r) * n;
          const coord = stride === n ? r : stride === size * n ? g : b;
          const prev = coord > 0 ? base - stride : base;
          const next = coord < size - 1 ? base + stride : base;
          for (let i = 0; i < n; i++) {
            data[base + i] = (tmp[prev + i]! + 2 * tmp[base + i]! + tmp[next + i]!) / 4;
          }
        }
      }
    }
  }
}
