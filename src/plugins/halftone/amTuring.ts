// AM halftone on a Turing pattern: winding lines (or spots) grown by a
// reaction–diffusion style process (engine/halftone/turing.ts). Lines thicken
// in darker areas: no line on white, lines touching each other at 100%.
//
// Two sizes:
// - Repeating tile: one seamless tile (about 146 lines across), grown once in
//   a few seconds. Each ink views it at its own offset and angle, unless
//   the inks share one pattern. Spacing and direction change instantly.
// - Whole image: a field as big as the output, so nothing repeats and lines
//   can follow the image's edges. Much slower: one field per ink (or one
//   shared), regrown when the output size or (with Follow image) the image changes.

import type { Gpu } from "../../engine/gl/gpu";
import { buildTuringField, type TuringField, type TuringParams } from "../../engine/halftone/turing";
import { defineSection } from "../../schema/types";
import { createRng } from "../../util/rng";
import { MAX_INKS } from "../../pipeline/coverage";
import { floatTexture, GLSL_LATTICE, latticeDotSettings, latticeUniforms } from "./lattice";
import { defineHalftoneMethod, type OutputInfo } from "./types";

/** Tile: texels across, and texels per wavelength (line spacing). */
const TILE = 1024;
const TILE_SAMPLES = 7;
/** Whole image: texels per wavelength (fewer for big outputs), and the largest field. */
const WHOLE_SAMPLES = 8;
const WHOLE_MIN_SAMPLES = 4.5;
const WHOLE_MAX_TEXELS = 12_000_000;

export const amTuringSection = defineSection({
  id: "halftoneTuring",
  title: "AM: Turing pattern",
  stage: "halftone",
  parent: "halftone",
  description: "Winding lines grown like a natural pattern (zebra stripes, coral). Lines get thicker in darker areas and touch at 100%.",
  visibleWhen: (s) => s.halftone?.type === "turing",
  settings: [
    {
      kind: "select",
      key: "size",
      label: "Pattern size",
      default: "tile",
      display: "segmented",
      options: [
        { value: "tile", label: "Repeating tile" },
        { value: "whole", label: "Whole image" },
      ],
      help: "Repeating tile: grows in a few seconds; the pattern repeats about every 146 lines. Whole image: nothing repeats and lines can follow the image, but it is much slower (about 30–40 s per ink for a Letter page at 600 DPI on a laptop; less with one shared pattern, a wider spacing or a smaller size), uses a lot of graphics memory, and regrows whenever the output size changes.",
    },
    { kind: "toggle", key: "shared", label: "Same pattern for all inks", default: false, help: "On: every ink uses the same lines, so overlapping inks stack. Off: each ink gets its own pattern." },
    { kind: "number", key: "cellSize", label: "Line spacing", perInk: true, default: 8, min: 3, max: 48, step: 0.5, unit: "px", help: "Distance between line centers, in output pixels.", visibleWhen: (s) => !s.shared },
    { kind: "number", key: "spacing", label: "Line spacing", default: 8, min: 3, max: 48, step: 0.5, unit: "px", help: "Distance between line centers, in output pixels.", visibleWhen: (s) => s.shared === true },
    { kind: "number", key: "spots", label: "Lines ↔ spots", default: 0, min: 0, max: 100, step: 1, unit: "%", help: "0 = continuous lines; higher breaks them into irregular spots." },
    { kind: "number", key: "branching", label: "Branching", default: 30, min: 0, max: 100, step: 1, unit: "%", help: "How often lines split, merge and end." },
    { kind: "number", key: "order", label: "Order", default: 0, min: 0, max: 100, step: 1, unit: "%", help: "0 = a winding maze; 100 = long parallel lines in the chosen direction." },
    {
      kind: "number",
      key: "direction",
      label: "Direction",
      perInk: true,
      linkInks: false,
      default: 0,
      slotDefaults: [0, 45, 90, 135],
      min: 0,
      max: 180,
      step: 1,
      unit: "°",
      help: "Which way ordered lines run.",
      visibleWhen: (s) => !s.shared && Number(s.order) > 0,
    },
    { kind: "number", key: "sharedDirection", label: "Direction", default: 0, min: 0, max: 180, step: 1, unit: "°", help: "Which way ordered lines run.", visibleWhen: (s) => s.shared === true && Number(s.order) > 0 },
    { kind: "number", key: "wobble", label: "Wobble", default: 20, min: 0, max: 100, step: 1, unit: "%", help: "How much the lines bend and wander." },
    {
      kind: "number",
      key: "follow",
      label: "Follow image",
      default: 50,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      help: "Lines run along edges and contours in the image. Regrows the pattern when the image changes.",
      visibleWhen: (s) => s.size === "whole",
    },
    { kind: "seed", key: "seed", label: "Random seed", default: 1 },
    // Lines have no dot shape; the size settings set their width.
    ...latticeDotSettings()
      .filter((def) => def.key !== "shape")
      .map((def) =>
        def.key === "maxDot"
          ? { ...def, label: "Maximum line width", help: "Widest line, as a share of the spacing. Below 100% even solid areas keep thin gaps." }
          : def.key === "curve"
            ? { ...def, label: "Line width curve", help: "Maps tone to line width. Pull the middle down for thinner lines in the midtones." }
            : def,
      ),
  ],
});

type Values = Record<string, unknown>;

interface Prepared {
  key: string;
  /** One field (tile, or shared whole image), or one per ink. */
  fields: TuringField[];
  /** Field texels per wavelength, per field. */
  samples: number[];
  /** Whole image: the spacing (output px) each field was grown at, per ink. */
  spacing: number[];
  /** Field index per ink. */
  fieldOf: number[];
  whole: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;

/** The spacing and direction each ink uses (shared mode: one for all). */
function perInk(v: Values, inkCount: number): { spacing: number[]; direction: number[] } {
  const shared = v.shared === true;
  const spacing = Array.from({ length: MAX_INKS }, (_, i) => Math.max(1, Number(shared ? v.spacing : ((v.cellSize as number[]) ?? [])[i] ?? 8)));
  const direction = Array.from({ length: MAX_INKS }, (_, i) => deg(Number(shared ? v.sharedDirection : ((v.direction as number[]) ?? [])[i] ?? 0)));
  return { spacing: spacing.map((s, i) => (i < inkCount ? s : spacing[0]!)), direction };
}

function params(v: Values, direction: number, seed: number, follow: boolean): TuringParams {
  return {
    spots: Number(v.spots) / 100,
    branching: Number(v.branching) / 100,
    order: Number(v.order) / 100,
    direction,
    wobble: Number(v.wobble) / 100,
    follow: follow ? Number(v.follow) / 100 : 0,
    seed,
  };
}

// Results still in use: the current one and the one before (shown until the
// next is ready, or held by an export). Older fields are freed.
const kept: { gpu: Gpu; prepared: Prepared }[] = [];
function keep(gpu: Gpu, prepared: Prepared): void {
  kept.push({ gpu, prepared });
  while (kept.length > 2) {
    const old = kept.shift()!;
    for (const f of old.prepared.fields) old.gpu.deleteTarget(f.target);
  }
}
/** Bumps on every new build, so an older build stops at its next pass. */
let buildToken = 0;

function wholeKey(v: Values, info: OutputInfo): unknown[] {
  const n = info.inkCount ?? 1;
  const { spacing, direction } = perInk(v, n);
  const follow = Number(v.follow) > 0;
  return [info.outputWidth, info.outputHeight, v.shared, spacing.slice(0, n), direction.slice(0, n), v.follow, follow ? info.imageKey : ""];
}

export const amTuring = defineHalftoneMethod({
  id: "turing",
  label: "AM: Turing pattern",
  section: amTuringSection,
  reach(values) {
    const { spacing } = perInk(values as unknown as Values, MAX_INKS);
    return Math.max(4, ...spacing) * 1.5;
  },
  prepareKey(values, info) {
    const v = values as unknown as Values;
    const base = [v.size, v.spots, v.branching, v.order, v.wobble, v.seed, v.shared];
    return JSON.stringify(v.size === "whole" ? [...base, ...wholeKey(v, info)] : base);
  },
  async prepare(values, info): Promise<Prepared> {
    const v = values as unknown as Values;
    const gpu = info.gpu;
    if (!gpu) throw new Error("The Turing pattern needs the GPU");
    const token = ++buildToken;
    const isCancelled = () => token !== buildToken;
    const key = JSON.stringify([amTuring.prepareKey!(values, info)]);
    const seed = Number(v.seed);

    if (v.size !== "whole") {
      // One tile; lines run along x (each ink rotates its view to its direction).
      const field = await buildTuringField(gpu, { width: TILE, height: TILE, samples: TILE_SAMPLES, periodic: true, params: params(v, 0, seed, false), isCancelled, onProgress: info.progress });
      const prepared: Prepared = { key, fields: [field], samples: [TILE_SAMPLES], spacing: [], fieldOf: [0, 0, 0, 0], whole: false };
      keep(gpu, prepared);
      return prepared;
    }

    const n = info.inkCount ?? 1;
    const { spacing, direction } = perInk(v, n);
    const shared = v.shared === true;
    const count = shared ? 1 : n;
    const follow = Number(v.follow) > 0 && !!info.analysis;
    const fields: TuringField[] = [];
    const samples: number[] = [];
    try {
      for (let i = 0; i < count; i++) {
        // Wavelengths across the output, and texels per wavelength within the size limit.
        const uw = info.outputWidth / spacing[i]!;
        const uh = info.outputHeight / spacing[i]!;
        const S = Math.min(WHOLE_SAMPLES, Math.sqrt(WHOLE_MAX_TEXELS / (uw * uh)));
        const w = Math.ceil(uw * S) + 2;
        const h = Math.ceil(uh * S) + 2;
        if (S < WHOLE_MIN_SAMPLES || Math.max(w, h) > gpu.maxTextureSize) {
          throw new Error("The whole-image pattern is too large for this output size. Use a repeating tile, a wider line spacing, or a lower resolution");
        }
        const analysis = follow ? info.analysis!() : null;
        const field = await buildTuringField(gpu, {
          width: w,
          height: h,
          samples: S,
          periodic: false,
          params: params(v, direction[i]!, seed + i * 101, follow),
          orientation: analysis
            ? {
                analysis,
                uvPerTexel: [spacing[i]! / (S * info.outputWidth), spacing[i]! / (S * info.outputHeight)],
                // About two line spacings, in analysis texels.
                sigma: Math.max(1, ((2 * spacing[i]!) / info.outputWidth) * analysis.width),
              }
            : undefined,
          isCancelled,
          onProgress: (f) => info.progress?.((i + f) / count),
        });
        fields.push(field);
        samples.push(S);
      }
    } catch (err) {
      for (const f of fields) gpu.deleteTarget(f.target);
      throw err;
    }
    const prepared: Prepared = {
      key,
      fields,
      samples,
      spacing,
      fieldOf: Array.from({ length: MAX_INKS }, (_, i) => (shared ? 0 : Math.min(i, count - 1))),
      whole: true,
    };
    keep(gpu, prepared);
    return prepared;
  },
  glsl: /* glsl */ `
${GLSL_LATTICE}
uniform sampler2D uTuField0;
uniform sampler2D uTuField1;
uniform sampler2D uTuField2;
uniform sampler2D uTuField3;
uniform ivec4 uTuFieldOf;      // field per ink
uniform vec2 uTuFieldSize[4];  // texels, per field
uniform vec4 uTuScale;         // field texels per output px, per ink
uniform vec4 uTuAngle;         // radians, per ink (tile: each ink's view)
uniform vec2 uTuOffset[4];     // texels, per ink
uniform int uTuPeriodic;
uniform sampler2D uTuTable;    // 256 × 1, RGBA32F: per ink, tone → field threshold

vec2 tuRaw(int f, ivec2 c) {
  if (f == 1) return texelFetch(uTuField1, c, 0).rg;
  if (f == 2) return texelFetch(uTuField2, c, 0).rg;
  if (f == 3) return texelFetch(uTuField3, c, 0).rg;
  return texelFetch(uTuField0, c, 0).rg;
}
float tuValue(int f, ivec2 c) {
  ivec2 n = ivec2(uTuFieldSize[f]);
  c = uTuPeriodic == 1 ? ((c % n) + n) % n : clamp(c, ivec2(0), n - 1);
  vec2 b = floor(tuRaw(f, c) * 255.0 + 0.5);
  return ((b.x * 256.0 + b.y) / 65535.0 - 0.5) * 4.0;
}
float tuField(int ink, vec2 p) {
  int f = uTuFieldOf[ink];
  vec2 q = latRotate(p, -uTuAngle[ink]) * uTuScale[ink] + uTuOffset[ink] - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 t = q - floor(q);
  float a = tuValue(f, i), b = tuValue(f, i + ivec2(1, 0));
  float c = tuValue(f, i + ivec2(0, 1)), d = tuValue(f, i + ivec2(1, 1));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

vec2 htSamplePoint(int ink, vec2 p) { return p; }

float htInk(int ink, vec2 p, float c) {
  c = latTone(ink, c);
  if (c <= 0.0) return 0.0;
  if (c >= 0.999) return 1.0;
  float x = c * 255.0;
  int i = int(floor(x));
  float lo = texelFetch(uTuTable, ivec2(min(i, 255), 0), 0)[ink];
  float hi = texelFetch(uTuTable, ivec2(min(i + 1, 255), 0), 0)[ink];
  return tuField(ink, p) >= mix(lo, hi, fract(x)) ? 1.0 : 0.0;
}
`,
  uniforms(values, ctx, prepared) {
    const v = values as unknown as Values;
    const { spacing, direction } = perInk(v, ctx.inkCount);
    const tone = latticeUniforms(v, ctx, "cellSize", null, { key: "turing", measure: () => new Float32Array(256) });
    // Minimum line width as a share of the spacing.
    const minFrac = Array.from({ length: 4 }, (_, i) => Math.min(1, (ctx.minDot[i] ?? 0) / spacing[i]!));
    const p = prepared;
    const fields = p?.fields ?? [];
    const table = new Float32Array(256 * 4).fill(1e9);
    if (p) {
      for (let ink = 0; ink < 4; ink++) {
        const f = fields[p.fieldOf[ink]!]!;
        for (let t = 0; t < 256; t++) table[t * 4 + ink] = f.thresholds[t]!;
      }
    }
    const shared = v.shared === true;
    const rng = createRng(Number(v.seed) * 4099 + 11);
    const offsets: number[] = [];
    for (let i = 0; i < 4; i++) offsets.push(rng() * TILE, rng() * TILE);
    const whole = p?.whole ?? false;
    // Whole image: the field fixes the spacing it was grown at, until the next one is ready.
    const scale = Array.from({ length: 4 }, (_, i) =>
      whole ? p!.samples[p!.fieldOf[i]!]! / p!.spacing[i]! : TILE_SAMPLES / spacing[i]!,
    );
    // Unused samplers still need a texture bound.
    const fallback = (tone.uLatCurve as { texture: WebGLTexture }).texture;
    const texture = (i: number) => ({ texture: (fields[i] ?? fields[0])?.target.texture ?? fallback });
    return {
      ...tone,
      uLatMinFrac: minFrac,
      uTuField0: texture(0),
      uTuField1: texture(1),
      uTuField2: texture(2),
      uTuField3: texture(3),
      uTuFieldOf: p?.fieldOf ?? [0, 0, 0, 0],
      uTuFieldSize: Array.from({ length: 4 }, (_, i) => {
        const f = fields[i] ?? fields[0];
        return f ? [f.width, f.height] : [1, 1];
      }).flat(),
      uTuScale: scale,
      uTuAngle: whole ? [0, 0, 0, 0] : direction,
      uTuOffset: whole ? [0, 0, 0, 0, 0, 0, 0, 0] : shared ? Array.from({ length: 4 }, () => [offsets[0]!, offsets[1]!]).flat() : offsets,
      uTuPeriodic: whole ? 0 : 1,
      uTuTable: { texture: floatTexture(ctx.gpu, `turing:${p?.key ?? "none"}`, 256, 1, table, 4) },
    };
  },
});
