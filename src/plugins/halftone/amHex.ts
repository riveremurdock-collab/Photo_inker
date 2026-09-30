// AM halftone on a hexagonal grid: dots in a honeycomb pattern (each dot has
// six equal neighbors), rotated per ink. Cell size gives the same dot density
// as the square grid.

import { defineSection } from "../../schema/types";
import { GLSL_LATTICE, GLSL_LATTICE_HT, latticeDotSettings, latticeUniforms, measureThresholds, type LatticeShape } from "./lattice";
import { defineHalftoneMethod } from "./types";

/** Neighbor distance of a hex lattice with one dot per unit area. */
const HEX_H = Math.sqrt(2 / Math.sqrt(3));
const HEX_ROW = (HEX_H * Math.sqrt(3)) / 2;

export const amHexSection = defineSection({
  id: "halftoneHex",
  title: "AM: hex grid",
  stage: "halftone",
  parent: "halftone",
  description: "Dots in a honeycomb pattern: each dot has six equal neighbors. Smoother-looking than a square grid.",
  visibleWhen: (s) => s.halftone?.type === "hex",
  settings: [
    { kind: "number", key: "cellSize", label: "Cell size", perInk: true, default: 8, min: 2, max: 64, step: 0.5, unit: "px", help: "Same dot density as a square grid of this size, in output pixels." },
    { kind: "number", key: "angle", label: "Angle", perInk: true, default: 30, slotDefaults: [0, 30, 15, 45], min: 0, max: 60, step: 0.5, unit: "°", help: "A hex grid repeats every 60°." },
    ...latticeDotSettings(),
  ],
});

/** Nearest hex lattice point (lattice units). Mirrors latNearest() below. */
function nearestHex(x: number, y: number): [number, number] {
  const jf = y / HEX_ROW;
  const i0 = Math.floor((x - jf * HEX_H * 0.5) / HEX_H);
  const j0 = Math.floor(jf);
  let best: [number, number] = [0, 0];
  let bestD = Infinity;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      const cx = i * HEX_H + j * HEX_H * 0.5;
      const cy = j * HEX_ROW;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [cx, cy];
      }
    }
  }
  return best;
}

export const amHex = defineHalftoneMethod({
  id: "hex",
  label: "AM: hex grid",
  section: amHexSection,
  glsl: /* glsl */ `
${GLSL_LATTICE}
const float HEX_H = ${HEX_H.toFixed(8)};
const float HEX_ROW = ${HEX_ROW.toFixed(8)};
vec2 latToLattice(int ink, vec2 p) { return latRotate(p, uLatAngle[ink]) / uLatSize[ink]; }
vec2 latFromLattice(int ink, vec2 q) { return latRotate(q * uLatSize[ink], -uLatAngle[ink]); }
vec2 latNearest(int ink, vec2 q) {
  float jf = q.y / HEX_ROW;
  vec2 base = floor(vec2((q.x - jf * HEX_H * 0.5) / HEX_H, jf));
  vec2 best = vec2(0.0);
  float bestD = 1e9;
  for (int dj = 0; dj <= 1; dj++) {
    for (int di = 0; di <= 1; di++) {
      vec2 ij = base + vec2(float(di), float(dj));
      vec2 c = vec2(ij.x * HEX_H + ij.y * HEX_H * 0.5, ij.y * HEX_ROW);
      float d = dot(q - c, q - c);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  return best;
}
${GLSL_LATTICE_HT}
`,
  uniforms(values, ctx) {
    return latticeUniforms(values as never, ctx, "cellSize", "angle", {
      key: "hex",
      measure: () =>
        measureThresholds(nearestHex, (values as unknown as { shape: LatticeShape }).shape, (rng) => [rng() * 40, rng() * 40]),
    });
  },
});
