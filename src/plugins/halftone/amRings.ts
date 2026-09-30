// AM halftone on concentric rings around a center point: dots evenly spaced
// along each ring, or continuous lines whose width carries the tone. Each ink
// rotates its dots along the rings (angle), so layers don't sit on top of
// each other.

import { defineSection } from "../../schema/types";
import { GLSL_LATTICE, latticeDotSettings, latticeUniforms, measureThresholds, type LatticeShape } from "./lattice";
import { defineHalftoneMethod } from "./types";

export const amRingsSection = defineSection({
  id: "halftoneRings",
  title: "AM: concentric rings",
  stage: "halftone",
  parent: "halftone",
  description: "Dots on rings around a center point, or continuous lines whose width changes with the tone.",
  visibleWhen: (s) => s.halftone?.type === "rings",
  settings: [
    { kind: "number", key: "cellSize", label: "Ring spacing", perInk: true, default: 8, min: 2, max: 64, step: 0.5, unit: "px" },
    {
      kind: "toggle",
      key: "lines",
      label: "Continuous lines instead of dots",
      default: false,
    },
    {
      kind: "number",
      key: "dotSpacing",
      label: "Dot spacing along each ring",
      default: 100,
      min: 50,
      max: 300,
      step: 5,
      unit: "%",
      help: "As a share of the ring spacing.",
      visibleWhen: (s) => !s.lines,
    },
    { kind: "number", key: "angle", label: "Dot rotation", perInk: true, default: 0, slotDefaults: [0, 15, 30, 45], min: 0, max: 360, step: 1, unit: "°", visibleWhen: (s) => !s.lines },
    { kind: "number", key: "centerX", label: "Center, across", default: 50, min: 0, max: 100, step: 0.5, unit: "%" },
    { kind: "number", key: "centerY", label: "Center, down", default: 50, min: 0, max: 100, step: 0.5, unit: "%" },
    ...latticeDotSettings(),
  ],
});

const TAU = Math.PI * 2;

/** Nearest dot center on the rings (lattice units: ring spacing = 1). Mirrors latNearest() below. */
function nearestRing(ratio: number) {
  return (x: number, y: number): [number, number] => {
    const r = Math.hypot(x, y);
    const theta = Math.atan2(y, x);
    const k0 = Math.round(r);
    let best: [number, number] = [0, 0];
    let bestD = Infinity;
    for (let k = Math.max(0, k0 - 1); k <= k0 + 1; k++) {
      const count = k === 0 ? 1 : Math.max(1, Math.round((TAU * k) / ratio));
      const j0 = Math.round((theta / TAU) * count);
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const a = (TAU * j) / count;
        const cx = k * Math.cos(a);
        const cy = k * Math.sin(a);
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [cx, cy];
        }
      }
    }
    return best;
  };
}

export const amRings = defineHalftoneMethod({
  id: "rings",
  label: "AM: concentric rings",
  section: amRingsSection,
  glsl: /* glsl */ `
${GLSL_LATTICE}
uniform vec2 uRingCenter;   // output px
uniform float uRingRatio;   // dot spacing / ring spacing
uniform int uRingLines;
const float TAU = 6.28318530718;

vec2 latToLattice(int ink, vec2 p) { return latRotate(p - uRingCenter, -uLatAngle[ink]) / uLatSize[ink]; }
vec2 latFromLattice(int ink, vec2 q) { return latRotate(q * uLatSize[ink], uLatAngle[ink]) + uRingCenter; }
vec2 latNearest(int ink, vec2 q) {
  float r = length(q);
  float theta = atan(q.y, q.x);
  float k0 = floor(r + 0.5);
  vec2 best = vec2(0.0);
  float bestD = 1e9;
  for (int dk = -1; dk <= 1; dk++) {
    float k = k0 + float(dk);
    if (k < 0.0) continue;
    float count = k < 0.5 ? 1.0 : max(1.0, floor(TAU * k / uRingRatio + 0.5));
    float j0 = floor(theta / TAU * count + 0.5);
    for (int dj = -1; dj <= 1; dj++) {
      float a = TAU * (j0 + float(dj)) / count;
      vec2 c = k * vec2(cos(a), sin(a));
      float d = dot(q - c, q - c);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  return best;
}

vec2 htSamplePoint(int ink, vec2 p) {
  vec2 q = latToLattice(ink, p);
  if (uRingLines == 1) {
    // Lines: the tone at the same angle on the nearest ring.
    float r = length(q);
    float k = floor(r + 0.5);
    return latFromLattice(ink, r > 1e-4 ? q * (k / r) : q);
  }
  return latFromLattice(ink, latNearest(ink, q));
}

float htInk(int ink, vec2 p, float c) {
  c = latTone(ink, c);
  if (c <= 0.0) return 0.0;
  if (c >= 0.999) return 1.0;
  vec2 q = latToLattice(ink, p);
  if (uRingLines == 1) {
    // Line width = tone × ring spacing, so the inked share of each band is the tone.
    float r = length(q);
    return abs(r - floor(r + 0.5)) < c * 0.5 ? 1.0 : 0.0;
  }
  return latSpot(q - latNearest(ink, q)) < latThreshold(c) ? 1.0 : 0.0;
}
`,
  uniforms(values, ctx) {
    const v = values as unknown as Record<string, unknown>;
    const ratio = Number(v.dotSpacing ?? 100) / 100;
    return {
      ...latticeUniforms(v, ctx, "cellSize", "angle", {
        key: `rings:${ratio}`,
        // Sample away from the center, where the rings look like the rest of the image.
        measure: () =>
          measureThresholds(nearestRing(ratio), (v.shape as LatticeShape) ?? "round", (rng) => {
            const r = Math.sqrt(100 + rng() * (1600 - 100));
            const a = rng() * TAU;
            return [r * Math.cos(a), r * Math.sin(a)];
          }),
      }),
      uRingCenter: [(Number(v.centerX ?? 50) / 100) * ctx.outputWidth, (Number(v.centerY ?? 50) / 100) * ctx.outputHeight],
      uRingRatio: ratio,
      uRingLines: v.lines ? 1 : 0,
    };
  },
});
