// Phyllotaxis spiral points (like seeds in a sunflower), bucketed for fast
// nearest-point lookups on the GPU. DOM-free: built in a worker.
//
// Lattice units: one point per unit of area, so point n sits at radius
// sqrt(n / π) and angle n × divergence. Buckets are 1 × 1 cells covering
// [-R, R]²; each holds up to 4 points, stored as their position inside the
// bucket in bytes (0–254; 255 = empty). Two RGBA texels per bucket.

export interface SpiralBuckets {
  count: number;
  /** Half-size of the bucket grid, in lattice units. */
  radius: number;
  /** Buckets per side. */
  grid: number;
  /** RGBA bytes, width 2 × grid, height grid. */
  data: Uint8Array;
}

export const SLOTS_PER_BUCKET = 4;

export function buildSpiral(count: number, divergenceDeg: number): SpiralBuckets {
  const radius = Math.sqrt(count / Math.PI) + 2;
  const grid = Math.ceil(radius * 2);
  const data = new Uint8Array(grid * 2 * grid * 4).fill(255);
  const fill = new Uint8Array(grid * grid);
  const step = (divergenceDeg * Math.PI) / 180;
  for (let n = 0; n < count; n++) {
    const r = Math.sqrt(n / Math.PI);
    const a = n * step;
    const x = r * Math.cos(a) + radius;
    const y = r * Math.sin(a) + radius;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    if (bx < 0 || by < 0 || bx >= grid || by >= grid) continue;
    const b = by * grid + bx;
    const slot = fill[b]!;
    if (slot >= SLOTS_PER_BUCKET) continue; // extremely rare with one point per unit area
    fill[b] = slot + 1;
    const o = (by * grid * 2 + bx * 2) * 4 + slot * 2;
    data[o] = Math.min(254, Math.floor((x - bx) * 254));
    data[o + 1] = Math.min(254, Math.floor((y - by) * 254));
  }
  return { count, radius, grid, data };
}

/** Nearest spiral point to (x, y) in lattice units (mirrors the GLSL). Null outside the table. */
export function nearestSpiral(s: SpiralBuckets, x: number, y: number): [number, number] | null {
  const bx0 = Math.floor(x + s.radius);
  const by0 = Math.floor(y + s.radius);
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bx = bx0 + dx;
      const by = by0 + dy;
      if (bx < 0 || by < 0 || bx >= s.grid || by >= s.grid) continue;
      for (let slot = 0; slot < SLOTS_PER_BUCKET; slot++) {
        const o = (by * s.grid * 2 + bx * 2) * 4 + slot * 2;
        if (s.data[o]! > 254) continue;
        const cx = bx - s.radius + (s.data[o]! + 0.5) / 254;
        const cy = by - s.radius + (s.data[o + 1]! + 0.5) / 254;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [cx, cy];
        }
      }
    }
  }
  return best;
}
