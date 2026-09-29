// Point curves (contrast curve, later per-layer curves and tone curves).
// Points are [x, y] in 0..1. Interpolation is monotone cubic (Fritsch–Carlson),
// so the curve passes through every point without overshooting between them.

export type CurvePoint = readonly [number, number];

/** Sorted by x, clamped to 0..1, with duplicate x values removed. */
export function normalizeCurve(points: readonly CurvePoint[]): [number, number][] {
  const sorted = points
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const p of sorted) {
    if (out.length && Math.abs(out[out.length - 1]![0] - p[0]) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length === 0) return [[0, 0], [1, 1]];
  return out;
}

/** Samples the curve at `size` evenly spaced x values from 0 to 1. */
export function sampleCurve(points: readonly CurvePoint[], size: number): Float32Array {
  const p = normalizeCurve(points);
  const n = p.length;
  const out = new Float32Array(size);
  if (n === 1) return out.fill(p[0]![1]);

  // Fritsch–Carlson tangents.
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1]![1] - p[i]![1]) / Math.max(1e-9, p[i + 1]![0] - p[i]![0]));
  const m: number[] = [d[0]!];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }

  let seg = 0;
  for (let k = 0; k < size; k++) {
    const x = k / (size - 1);
    if (x <= p[0]![0]) {
      out[k] = p[0]![1];
      continue;
    }
    if (x >= p[n - 1]![0]) {
      out[k] = p[n - 1]![1];
      continue;
    }
    while (seg < n - 2 && x > p[seg + 1]![0]) seg++;
    const [x0, y0] = p[seg]!;
    const [x1, y1] = p[seg + 1]!;
    const h = x1 - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[k] =
      (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[seg]! + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[seg + 1]!;
    out[k] = Math.min(1, Math.max(0, out[k]!));
  }
  return out;
}
