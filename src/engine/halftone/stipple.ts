// FM stipple: hand-stippled dots with no grid. DOM-free: runs in a worker.
//
// Placement: one large set of points (a torus of STIPPLE_TILE × STIPPLE_TILE
// "dot units", STIPPLE_DENSITY points per unit²) spread by best-candidate
// sampling. Points are ranked in the order they were placed, and every prefix
// of that order is itself evenly spread, so "draw the dots whose rank is below
// the tone" gives few, evenly spaced dots in light areas and many in dark
// ones, with no grid anywhere. One dot unit = the ink's dot size in pixels.
//
// Points are stored in 1 × 1 buckets for the GPU: STIPPLE_SLOTS texels per
// bucket (RGBA8: x, y inside the bucket, rank high byte, rank low byte), sorted
// by rank; rank 65535 = empty.
//
// Each dot's shape comes from a formula driven by hashes of its id (size,
// angle, polygon sides, wobble and edge harmonics, grain), so every dot is
// different at no storage cost. The same formula runs in GLSL (fmStipple.ts)
// and here, where it is used to measure the tone each rank threshold really
// gives (dots overlap, vary in size and bleed together), so the GPU can pick
// the threshold that inks exactly the wanted share of paper.

export const STIPPLE_TILE = 512;
export const STIPPLE_SLOTS = 8;
export const STIPPLE_DENSITY = 2;
export const STIPPLE_LEVELS = 33;
/** Farthest a dot may reach from its center, in dot units (limits the GPU search). */
export const STIPPLE_MAX_REACH = 3;

export interface StippleParams {
  /** 0 round, 1 chip (irregular polygon), 2 dash. */
  shape: number;
  sizeVar: number;
  toneSize: number;
  wobble: number;
  rough: number;
  stretch: number;
  /** Radians. */
  dirAngle: number;
  dirVar: number;
  bleed: number;
  grain: number;
}

// ---- Hashing (mirrored exactly in GLSL: stHash / stRnd / stNoise) ----

export function stHash(v: number): number {
  v = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((v >>> ((v >>> 28) + 4)) ^ v) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

function rnd(base: number, k: number): number {
  return (stHash((base + Math.imul(k, 0x9e3779b9)) >>> 0) >>> 8) / 16777216;
}

function noiseCorner(ix: number, iy: number, seed: number): number {
  return (stHash(((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) ^ seed) >>> 0) >>> 8) / 16777216;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = noiseCorner(ix, iy, seed);
  const b = noiseCorner(ix + 1, iy, seed);
  const c = noiseCorner(ix, iy + 1, seed);
  const d = noiseCorner(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// ---- Dot shape ----

export interface StippleDerived {
  major: number;
  minor: number;
  /** Farthest the outline reaches, in units of the dot's radius along its long axis. */
  extent: number;
  /** Bleed distance, dot units. */
  bleed: number;
  /** Search radius, dot units. */
  reach: number;
}

export function deriveStipple(q: StippleParams): StippleDerived {
  const aspect = Math.min(8, (q.shape === 2 ? 3.5 : 1) * (1 + 2 * q.stretch));
  const major = Math.sqrt(aspect);
  const extent = 1 + 0.33 * q.wobble + 0.3 * q.rough + q.grain;
  const bleed = q.bleed * 0.5;
  const sMax = Math.exp(0.7 * q.sizeVar);
  const gMax = 1 + 0.5 * q.toneSize;
  const reach = Math.min(STIPPLE_MAX_REACH, 0.5 * sMax * gMax * major * extent + bleed);
  return { major, minor: 1 / major, extent, bleed, reach };
}

const ROUGH_K = [7, 11, 17];

/**
 * Signed distance (dot units, negative inside) from offset (vx, vy) to the
 * outline of the dot with hash `base`, at tone c. Infinity when out of reach.
 * Mirrors stSdf() in GLSL.
 */
export function stippleSdf(vx: number, vy: number, c: number, base: number, minFrac: number, q: StippleParams, dv: StippleDerived): number {
  const g = 1 + q.toneSize * (c - 0.5);
  const s = Math.exp(0.7 * q.sizeVar * (2 * rnd(base, 0) - 1));
  const r = Math.max(0.5 * s * g, 0.5 * minFrac);
  const bound = r * dv.major * dv.extent + dv.bleed;
  if (vx * vx + vy * vy > bound * bound) return Infinity;
  const ang = q.dirAngle + q.dirVar * (rnd(base, 1) - 0.5) * 2 * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const ux = (ca * vx + sa * vy) / (r * dv.major);
  const uy = (-sa * vx + ca * vy) / (r * dv.minor);
  const len = Math.hypot(ux, uy);
  const th = len < 1e-4 ? 0 : Math.atan2(uy, ux);
  let R = 1;
  if (q.shape === 1) {
    const n = 3 + Math.floor(rnd(base, 2) * 4);
    const sec = (2 * Math.PI) / n;
    const m = (th + Math.PI) % sec;
    R = Math.cos(Math.PI / n) / Math.cos(m - Math.PI / n);
  }
  if (q.wobble > 0) {
    let w = 0;
    for (let k = 2; k <= 4; k++) w += (2 * rnd(base, 1 + k) - 1) * (0.3 / k) * Math.cos(k * th + 2 * Math.PI * rnd(base, 4 + k));
    R += q.wobble * w;
  }
  if (q.rough > 0) {
    let w = 0;
    for (let j = 0; j < 3; j++) {
      const k = ROUGH_K[j]!;
      w += rnd(base, 9 + j) * 0.12 * Math.sqrt(7 / k) * Math.cos(k * th + 2 * Math.PI * rnd(base, 12 + j));
    }
    R += q.rough * w;
  }
  let sdf = len - R;
  if (q.grain > 0) sdf += q.grain * (valueNoise(ux * 2.5 + 64, uy * 2.5 + 64, stHash((base + 15) >>> 0)) - 0.3) * 1.4;
  return sdf * r * dv.minor;
}

/** Polynomial smooth minimum (k = 0: plain min). Mirrors stSmin(). */
export function stSmin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---- Point set ----

/** Best-candidate points on a T × T torus, in placement (rank) order: x, y interleaved. */
export function generateStipplePoints(T: number, n: number, seed: number, candidates = 12): Float32Array {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = new Float32Array(n * 2);
  const next = new Int32Array(n);
  let G = 1;
  let cs = T;
  let head = new Int32Array(1).fill(-1);
  const insert = (i: number) => {
    const cx = Math.min(G - 1, Math.floor(pts[i * 2]! / cs));
    const cy = Math.min(G - 1, Math.floor(pts[i * 2 + 1]! / cs));
    const c = cy * G + cx;
    next[i] = head[c]!;
    head[c] = i;
  };
  const rebuild = (count: number) => {
    G = Math.max(1, Math.floor(Math.sqrt(count)));
    cs = T / G;
    head = new Int32Array(G * G).fill(-1);
    for (let i = 0; i < count; i++) insert(i);
  };
  const half = T / 2;
  const wrap = (d: number) => (d > half ? d - T : d < -half ? d + T : d);
  const nearest2 = (x: number, y: number): number => {
    const cx = Math.min(G - 1, Math.floor(x / cs));
    const cy = Math.min(G - 1, Math.floor(y / cs));
    let best = Infinity;
    for (let ring = 0; ring <= G; ring++) {
      if (ring > 0) {
        const gap = (ring - 1) * cs;
        if (gap * gap > best) break;
      }
      for (let dy = -ring; dy <= ring; dy++) {
        const edgeRow = dy === -ring || dy === ring;
        const step = edgeRow ? 1 : 2 * ring;
        for (let dx = -ring; dx <= ring; dx += step || 1) {
          const gx = (((cx + dx) % G) + G) % G;
          const gy = (((cy + dy) % G) + G) % G;
          for (let j = head[gy * G + gx]!; j >= 0; j = next[j]!) {
            const ddx = wrap(pts[j * 2]! - x);
            const ddy = wrap(pts[j * 2 + 1]! - y);
            const d = ddx * ddx + ddy * ddy;
            if (d < best) best = d;
          }
        }
      }
    }
    return best;
  };
  pts[0] = rng() * T;
  pts[1] = rng() * T;
  rebuild(1);
  let nextRebuild = 4;
  for (let i = 1; i < n; i++) {
    if (i >= nextRebuild) {
      rebuild(i);
      nextRebuild *= 2;
    }
    let bestD = -1;
    let bx = 0;
    let by = 0;
    for (let k = 0; k < candidates; k++) {
      const x = rng() * T;
      const y = rng() * T;
      const d = nearest2(x, y);
      if (d > bestD) {
        bestD = d;
        bx = x;
        by = y;
      }
    }
    pts[i * 2] = bx;
    pts[i * 2 + 1] = by;
    insert(i);
  }
  return pts;
}

/**
 * Packs points into buckets for the GPU, each nudged at random by up to
 * `irregularity` × 0.7 dot units (0 = evenly spread, 1 = close to fully random).
 */
export function bucketStipplePoints(pts: Float32Array, T: number, irregularity: number): Uint8Array {
  const n = pts.length / 2;
  const data = new Uint8Array(T * STIPPLE_SLOTS * T * 4);
  for (let i = 0; i < T * STIPPLE_SLOTS * T; i++) {
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const fill = new Uint8Array(T * T);
  for (let i = 0; i < n; i++) {
    let x = pts[i * 2]!;
    let y = pts[i * 2 + 1]!;
    if (irregularity > 0) {
      const h = stHash(i ^ 0x5bd1e995);
      const a = rnd(h, 0) * 2 * Math.PI;
      const r = Math.sqrt(rnd(h, 1)) * irregularity * 0.7;
      x = (((x + r * Math.cos(a)) % T) + T) % T;
      y = (((y + r * Math.sin(a)) % T) + T) % T;
    }
    const bx = Math.min(T - 1, Math.floor(x));
    const by = Math.min(T - 1, Math.floor(y));
    const b = by * T + bx;
    const slot = fill[b]!;
    if (slot >= STIPPLE_SLOTS) continue; // very rare; drops a late (dark-tone) point
    fill[b] = slot + 1;
    const rank = Math.min(65534, Math.floor((i * 65535) / n));
    const o = (by * T * STIPPLE_SLOTS + bx * STIPPLE_SLOTS + slot) * 4;
    data[o] = Math.min(254, Math.floor((x - bx) * 255));
    data[o + 1] = Math.min(254, Math.floor((y - by) * 255));
    data[o + 2] = rank >> 8;
    data[o + 3] = rank & 255;
  }
  return data;
}

// ---- Tone measurement ----

const MEASURE_SALT = 0x2545f491;

/**
 * For each tone c = j / (STIPPLE_LEVELS - 1), the rank threshold that inks a share c of the
 * paper with these dot settings (measured by sampling random points).
 * Values above 1 mean "every dot" (that tone can't be fully reached).
 */
export function measureStipple(data: Uint8Array, T: number, q: StippleParams, minFrac = 0, samples = 2048): Float32Array {
  const dv = deriveStipple(q);
  const out = new Float32Array(STIPPLE_LEVELS);
  out[0] = -1;
  let seed = 0x9e3779b9;
  const rng = () => {
    seed = stHash(seed);
    return (seed >>> 8) / 16777216;
  };
  const ms = new Float32Array(samples);
  // Candidates near the sample: rank, offset and id. Shapes are only evaluated
  // in rank order until the sample is inked (most samples stop early).
  const candRank: number[] = [];
  const candX: number[] = [];
  const candY: number[] = [];
  const candId: number[] = [];
  const order: number[] = [];
  const reach2 = dv.reach * dv.reach;
  for (let j = 1; j < STIPPLE_LEVELS; j++) {
    const c = j / (STIPPLE_LEVELS - 1);
    for (let s = 0; s < samples; s++) {
      const x = T + rng() * T;
      const y = T + rng() * T;
      candRank.length = 0;
      candX.length = 0;
      candY.length = 0;
      candId.length = 0;
      const x0 = Math.floor(x - dv.reach);
      const x1 = Math.floor(x + dv.reach);
      const y0 = Math.floor(y - dv.reach);
      const y1 = Math.floor(y + dv.reach);
      for (let by = y0; by <= y1; by++) {
        const wy = by % T;
        for (let bx = x0; bx <= x1; bx++) {
          const wx = bx % T;
          for (let k = 0; k < STIPPLE_SLOTS; k++) {
            const o = (wy * T * STIPPLE_SLOTS + wx * STIPPLE_SLOTS + k) * 4;
            const rank16 = data[o + 2]! * 256 + data[o + 3]!;
            if (rank16 > 65534) break;
            const vx = x - (bx + (data[o]! + 0.5) / 255);
            const vy = y - (by + (data[o + 1]! + 0.5) / 255);
            if (vx * vx + vy * vy > reach2) continue;
            candRank.push(rank16);
            candX.push(vx);
            candY.push(vy);
            candId.push(((wy * T + wx) * STIPPLE_SLOTS + k) >>> 0);
          }
        }
      }
      order.length = candRank.length;
      for (let i = 0; i < order.length; i++) order[i] = i;
      order.sort((a, b) => candRank[a]! - candRank[b]!);
      let acc = 1e9;
      let m = 2;
      for (const i of order) {
        const d = stippleSdf(candX[i]!, candY[i]!, c, stHash((candId[i]! ^ MEASURE_SALT) >>> 0), minFrac, q, dv);
        if (d === Infinity) continue;
        acc = stSmin(acc, d, dv.bleed);
        if (acc < 0) {
          m = (candRank[i]! + 0.5) / 65535;
          break;
        }
      }
      ms[s] = m;
    }
    ms.sort();
    const k = Math.round(c * samples);
    out[j] = Math.max(out[j - 1]!, k >= samples ? 2 : ms[k]!);
  }
  return out;
}
