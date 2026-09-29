// Tone Map curve engine: every Tone Map result is one curve per ink, mapping
// lightness (0 = black, 1 = white) to ink density. Simple mode (bands) is a
// preset that builds these curves; Advanced mode edits them directly, so
// switching modes shows the bands as curves.

import { hexToRgb, rgbToLab } from "../../util/color";
import { sampleCurve, type CurvePoint } from "../../util/curve";
import { MAX_INKS } from "../../pipeline/coverage";

/** Named starting points for an ink's curve in Advanced mode (x = lightness, y = density). */
export const CURVE_PRESETS: readonly { id: string; label: string; points: [number, number][] }[] = [
  { id: "shadow", label: "Shadow ink", points: [[0, 1], [0.3, 0.85], [0.6, 0.15], [0.8, 0], [1, 0]] },
  { id: "midtone", label: "Midtone ink", points: [[0, 0.15], [0.25, 0.6], [0.5, 0.85], [0.75, 0.35], [1, 0]] },
  { id: "highlight", label: "Highlight tint", points: [[0, 0.25], [0.6, 0.35], [0.9, 0.1], [1, 0]] },
  { id: "full", label: "Full range", points: [[0, 1], [1, 0]] },
  { id: "off", label: "Off", points: [[0, 0], [1, 0]] },
];

/** Per-ink curves (Advanced mode) as interleaved densities, like bandsToCurves. */
export function pointCurvesToCurves(curves: readonly (readonly CurvePoint[])[]): Float32Array {
  const out = new Float32Array(CURVE_SIZE * MAX_INKS);
  curves.slice(0, MAX_INKS).forEach((points, ink) => {
    const samples = sampleCurve(points, CURVE_SIZE);
    for (let i = 0; i < CURVE_SIZE; i++) out[i * MAX_INKS + ink] = samples[i]!;
  });
  return out;
}

/**
 * Turns one ink's sampled curve into a few editable points (Douglas–Peucker
 * simplification). Hard band edges survive as two points one step apart.
 */
export function curveToPoints(curves: Float32Array, ink: number, tolerance = 0.01): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < CURVE_SIZE; i++) pts.push([i / (CURVE_SIZE - 1), curves[i * MAX_INKS + ink]!]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]!;
      const t = (x - ax) / (bx - ax);
      const d = Math.abs(y - (ay + t * (by - ay)));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}

/** Curve resolution: lightness steps. */
export const CURVE_SIZE = 256;

export type Falloff = "hard" | "linear" | "smooth";
export type Fill = "flat" | "gradient";

export interface BandSetup {
  /** Band boundaries between dark and light, 0..1, ascending (length = bands − 1). */
  cutoffs: number[];
  /** Ink slot per band (darkest band first), or null for bare paper. */
  bandInks: (number | null)[];
  /** Overlap width at each boundary, 0..1 of the lightness range. */
  overlaps: number[];
  falloff: Falloff;
  fill: Fill;
  /** Steps within a band for gradient fill; 0 = smooth. */
  posterize: number;
}

/**
 * Resolves each band's ink choice ("auto", "paper", or an ink slot number).
 * "auto": darker bands get darker inks, filled from the darkest band up; bands
 * left over once the inks run out are paper.
 */
export function resolveBandInks(choices: readonly string[], bandCount: number, inkHexes: readonly string[]): (number | null)[] {
  const byLightness = inkHexes
    .map((hex, slot) => ({ slot, l: rgbToLab(hexToRgb(hex) ?? { r: 0, g: 0, b: 0 }).l }))
    .sort((a, b) => a.l - b.l)
    .map((x) => x.slot);
  const autoInks: (number | null)[] = [];
  // With more bands than inks, the lightest band is left as paper (highlights stay unprinted).
  const paperBand = bandCount >= 2 && bandCount > inkHexes.length ? bandCount - 1 : -1;
  let next = 0;
  for (let b = 0; b < bandCount; b++) {
    if (b === paperBand || next >= byLightness.length) autoInks.push(null);
    else autoInks.push(byLightness[next++]!);
  }
  return Array.from({ length: bandCount }, (_, b) => {
    const choice = choices[b] ?? "auto";
    if (choice === "auto") return autoInks[b] ?? null;
    if (choice === "paper") return null;
    const slot = Number(choice);
    return Number.isInteger(slot) && slot >= 0 && slot < inkHexes.length ? slot : null;
  });
}

function shape(t: number, falloff: Falloff): number {
  const x = Math.min(1, Math.max(0, t));
  if (falloff === "hard") return x < 0.5 ? 0 : 1;
  if (falloff === "linear") return x;
  return x * x * (3 - 2 * x);
}

/**
 * Builds the per-ink curves as CURVE_SIZE × MAX_INKS densities (0..1),
 * interleaved: curves[i * MAX_INKS + ink].
 */
export function bandsToCurves(setup: BandSetup): Float32Array {
  const bands = setup.bandInks.length;
  const edges = [0, ...setup.cutoffs, 1];
  const out = new Float32Array(CURVE_SIZE * MAX_INKS);

  for (let i = 0; i < CURVE_SIZE; i++) {
    const l = i / (CURVE_SIZE - 1);
    for (let b = 0; b < bands; b++) {
      const ink = setup.bandInks[b];
      if (ink === null || ink === undefined) continue;
      const lo = edges[b]!;
      const hi = edges[b + 1]!;

      // Membership: 1 inside the band, fading across each boundary's overlap zone.
      let m = 1;
      if (b > 0) {
        const w = setup.overlaps[b - 1] ?? 0;
        m *= w > 0 ? shape((l - (lo - w / 2)) / w, setup.falloff) : l >= lo ? 1 : 0;
      }
      if (b < bands - 1) {
        const w = setup.overlaps[b] ?? 0;
        m *= w > 0 ? 1 - shape((l - (hi - w / 2)) / w, setup.falloff) : l < hi ? 1 : 0;
      }
      if (m <= 0) continue;

      // Density inside the band: flat, or keep the tonal gradient (darker = more ink).
      let d = 1;
      if (setup.fill === "gradient") {
        const u = hi > lo ? Math.min(1, Math.max(0, (l - lo) / (hi - lo))) : 0;
        d = 1 - u;
        if (setup.posterize > 0) d = Math.ceil(d * setup.posterize) / setup.posterize;
      }
      const idx = i * MAX_INKS + ink;
      out[idx] = Math.max(out[idx]!, m * d);
    }
  }
  return out;
}
