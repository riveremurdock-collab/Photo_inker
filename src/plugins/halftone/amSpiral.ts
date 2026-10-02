// AM halftone on a phyllotaxis spiral (like seeds in a sunflower): points
// placed at a fixed divergence angle (137.5°, the golden angle, packs them
// evenly), radiating from a center point. Each ink rotates the spiral by its
// own angle so layers don't sit on top of each other.
//
// The point table (built once in a worker, for as many points as the output
// needs) is shared by all inks: each ink's spacing and rotation are just a
// change of coordinates.

import { TextureCache } from "../../engine/gl/textureCache";
import type { SpiralBuckets } from "../../engine/halftone/spiral";
import { nearestSpiral } from "../../engine/halftone/spiral";
import { defineSection } from "../../schema/types";
import { GLSL_LATTICE, GLSL_LATTICE_HT, latticeDotSettings, latticeUniforms, measureThresholds, type LatticeShape } from "./lattice";
import { halftoneWorker } from "./halftoneWorker";
import { defineHalftoneMethod, type OutputInfo } from "./types";

export const amSpiralSection = defineSection({
  id: "halftoneSpiral",
  title: "AM: phyllotaxis spiral",
  stage: "halftone",
  parent: "halftone",
  description: "Dots spiraling out from a center, like seeds in a sunflower.",
  visibleWhen: (s) => s.halftone?.type === "spiral",
  settings: [
    { kind: "number", key: "cellSize", label: "Point spacing", perInk: true, default: 8, min: 2, max: 64, step: 0.5, unit: "px" },
    { kind: "number", key: "angle", label: "Spiral rotation", perInk: true, default: 0, slotDefaults: [0, 23, 46, 69], min: 0, max: 360, step: 1, unit: "°" },
    {
      kind: "number",
      key: "divergence",
      label: "Divergence angle",
      default: 137.5,
      min: 100,
      max: 180,
      step: 0.1,
      unit: "°",
      help: "Angle between one point and the next. 137.5° (the golden angle) packs points most evenly.",
    },
    { kind: "number", key: "centerX", label: "Center, across", default: 50, min: 0, max: 100, step: 0.5, unit: "%" },
    { kind: "number", key: "centerY", label: "Center, down", default: 50, min: 0, max: 100, step: 0.5, unit: "%" },
    ...latticeDotSettings(),
  ],
});

type Values = Record<string, unknown>;

const GOLDEN_ANGLE = 180 * (3 - Math.sqrt(5));

/**
 * 137.5° (the displayed default) is exactly 55/144 of a turn, a rational
 * fraction: far from the center its points line up into 144 straight spokes.
 * Values that round to 137.5 use the true golden angle, which never repeats.
 */
function divergence(values: Values): number {
  const d = Number(values.divergence);
  return Math.abs(d - 137.5) < 0.05 ? GOLDEN_ANGLE : d;
}

/** Points needed to cover the output from the center to its farthest corner, rounded up to a power of 2. */
function pointCount(values: Values, info: OutputInfo): number {
  const cx = (Number(values.centerX ?? 50) / 100) * info.outputWidth;
  const cy = (Number(values.centerY ?? 50) / 100) * info.outputHeight;
  const far = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(info.outputWidth - cx, cy),
    Math.hypot(cx, info.outputHeight - cy),
    Math.hypot(info.outputWidth - cx, info.outputHeight - cy),
  );
  const spacing = Math.max(1, Math.min(...((values.cellSize as number[]) ?? [8])));
  const radius = far / spacing + 3;
  return 2 ** Math.ceil(Math.log2(Math.PI * radius * radius));
}

export const amSpiral = defineHalftoneMethod({
  id: "spiral",
  label: "AM: phyllotaxis spiral",
  section: amSpiralSection,
  prepareKey: (values, info) => `${values.divergence}|${pointCount(values as never, info)}`,
  async prepare(values, info): Promise<SpiralBuckets> {
    const result = await halftoneWorker("spiral").run({ kind: "spiral", count: pointCount(values as never, info), divergence: divergence(values as never) });
    if (result.kind !== "spiral") throw new Error("unexpected worker result");
    return result;
  },
  glsl: /* glsl */ `
${GLSL_LATTICE}
uniform sampler2D uSpiral;      // 2 texels per bucket, 2 points per texel (bytes; 255 = empty)
uniform float uSpiralR;         // bucket grid half-size (lattice units)
uniform int uSpiralGrid;
uniform vec2 uSpiralCenter;     // output px
vec2 latToLattice(int ink, vec2 p) { return latRotate(p - uSpiralCenter, -uLatAngle[ink]) / uLatSize[ink]; }
vec2 latFromLattice(int ink, vec2 q) { return latRotate(q * uLatSize[ink], uLatAngle[ink]) + uSpiralCenter; }
vec2 latNearest(int ink, vec2 q) {
  ivec2 b0 = ivec2(floor(q + uSpiralR));
  vec2 best = q + vec2(100.0); // outside the table: no dot nearby
  float bestD = 1e9;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 b = b0 + ivec2(dx, dy);
      if (b.x < 0 || b.y < 0 || b.x >= uSpiralGrid || b.y >= uSpiralGrid) continue;
      for (int t = 0; t < 2; t++) {
        vec4 s = texelFetch(uSpiral, ivec2(b.x * 2 + t, b.y), 0) * 255.0;
        vec2 origin = vec2(b) - uSpiralR;
        if (s.x < 254.5) {
          vec2 c = origin + (s.xy + 0.5) / 254.0;
          float d = dot(q - c, q - c);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (s.z < 254.5) {
          vec2 c = origin + (s.zw + 0.5) / 254.0;
          float d = dot(q - c, q - c);
          if (d < bestD) { bestD = d; best = c; }
        }
      }
    }
  }
  return best;
}
${GLSL_LATTICE_HT}
`,
  uniforms(values, ctx, table) {
    const v = values as unknown as Values;
    const gl = ctx.gpu.gl;
    const texture = spiralTextures.get(gl, table ?? emptyTable, () => {
      const t = table ?? emptyTable;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, t.grid * 2, t.grid, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.data);
      return tex;
    });
    const t = table ?? emptyTable;
    const shape = (v.shape as LatticeShape) ?? "round";
    return {
      ...latticeUniforms(v, ctx, "cellSize", "angle", {
        key: `spiral:${divergence(v)}:${t.count}`,
        measure: () => {
          // Sample the whole spiral (area-uniform), since that is what covers the output.
          const maxR = Math.max(6, t.radius - 3);
          return measureThresholds(
            (x, y) => nearestSpiral(t, x, y) ?? [x + 100, y + 100],
            shape,
            (rng) => {
              const r = Math.sqrt(25 + rng() * (maxR * maxR - 25));
              const a = rng() * Math.PI * 2;
              return [r * Math.cos(a), r * Math.sin(a)];
            },
          );
        },
      }),
      uSpiral: { texture },
      uSpiralR: t.radius,
      uSpiralGrid: t.grid,
      uSpiralCenter: [(Number(v.centerX ?? 50) / 100) * ctx.outputWidth, (Number(v.centerY ?? 50) / 100) * ctx.outputHeight],
    };
  },
});

const emptyTable: SpiralBuckets = { count: 0, radius: 1, grid: 1, data: new Uint8Array(8).fill(255) };
const spiralTextures = new TextureCache<SpiralBuckets>();
