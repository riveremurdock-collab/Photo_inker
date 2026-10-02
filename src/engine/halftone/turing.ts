// Turing pattern fields for the AM: Turing pattern halftone, grown on the GPU.
//
// A field u starts as faint noise and is repeatedly replaced by
// tanh(gain × (short blur − long blur) + bias): the short blur activates,
// the long blur inhibits, and stripes about one wavelength apart settle out
// (a Turing / Swift–Hohenberg style labyrinth). Field units: `samples` texels
// per wavelength (line spacing).
//
// - Order and Follow image: a directional version of the same step (the
//   blur difference across the local direction, then smoothing along it) is
//   blended in, so lines run along the direction: a global angle, or the
//   image's edges (from the structure tensor of the image gradient).
// - Wobble: slow noise bends that direction.
// - Lines ↔ spots: a bias that breaks the symmetry between ink and paper, so
//   the ink phase breaks into spots.
// - Branching: a patchy bias that makes lines split, merge and end.
//
// The settled field is smoothed (a soft ridge along each line) and its
// distribution measured: for each tone, the field threshold that inks exactly
// that share of the area. Lines then grow from their centers as the tone
// darkens, until they touch at 100%.
//
// Values are stored as 16-bit fixed point in two 8-bit channels (RGBA8
// targets only, no float-render extension needed). Every pass is drawn in
// timed bands (engine/gl/bands.ts) and the build yields between them, so it
// never stalls the page or trips the GPU watchdog.

import { bandRows, timedBand } from "../gl/bands";
import type { Gpu, Target, UniformValue } from "../gl/gpu";
import { SupersededError } from "../../workers/workerClient";

export interface TuringParams {
  /** 0 = lines, 1 = spots. */
  spots: number;
  /** 0–1: how often lines split, merge and end. */
  branching: number;
  /** 0–1: winding maze → parallel lines along `direction`. */
  order: number;
  /** Radians: the way ordered lines run. */
  direction: number;
  /** 0–1: waviness of the direction. */
  wobble: number;
  /** 0–1: how strongly lines follow the image's edges (needs `orientation`). */
  follow: number;
  seed: number;
}

/** The image's edges, for Follow image. */
export interface TuringOrientation {
  /** Analysis texture: R luminance, G/B = 0.5 + gradient / 2 (row 0 = image top). */
  analysis: Target;
  /** Image uv per field texel (x, y). */
  uvPerTexel: [number, number];
  /** Blur for the edge directions, in analysis texels. */
  sigma: number;
}

export interface TuringBuild {
  width: number;
  height: number;
  /** Field texels per wavelength. */
  samples: number;
  /** Repeats seamlessly (a tile). */
  periodic: boolean;
  params: TuringParams;
  orientation?: TuringOrientation;
  /** Called between passes; returning true abandons the build. */
  isCancelled(): boolean;
  /** Share of the growth done (0–1), after each iteration. */
  onProgress?(fraction: number): void;
}

export interface TuringField {
  /** RG = smoothed field, 16-bit fixed point (see tuUnpack). */
  target: Target;
  width: number;
  height: number;
  /** Tone (0–255) → field threshold: ink where the field is at least this. */
  thresholds: Float32Array;
}

/** Iterations of the growth step. */
const ITERATIONS = 50;
const GAIN = 5.5;
const RELAX = 0.5;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uSize;
uniform int uPeriodic;
out vec4 outColor;

// u in [-2, 2] as 16 bits over two 8-bit channels.
vec2 tuPack(float u) {
  float x = floor(clamp(u * 0.25 + 0.5, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(x / 256.0);
  return vec2(hi, x - hi * 256.0) / 255.0;
}
float tuUnpack(vec2 rg) {
  vec2 b = floor(rg * 255.0 + 0.5);
  return ((b.x * 256.0 + b.y) / 65535.0 - 0.5) * 4.0;
}
ivec2 tuWrap(ivec2 c) {
  ivec2 n = ivec2(uSize);
  if (uPeriodic == 1) return ((c % n) + n) % n;
  return clamp(c, ivec2(0), n - 1);
}
// Packed value at a texel (RG or BA).
float tuAt(sampler2D t, ivec2 c) { return tuUnpack(texelFetch(t, tuWrap(c), 0).rg); }
float tuAtBA(sampler2D t, ivec2 c) { return tuUnpack(texelFetch(t, tuWrap(c), 0).ba); }
// Bilinear packed value at a position in texels (texel centers at +0.5).
float tuBilinear(sampler2D t, vec2 pos) {
  vec2 q = pos - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - floor(q);
  float a = tuAt(t, i), b = tuAt(t, i + ivec2(1, 0)), c = tuAt(t, i + ivec2(0, 1)), d = tuAt(t, i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float tuGauss(float k, float s) { return exp(-0.5 * k * k / (s * s)); }

uint tuHash(ivec2 c, int salt) {
  uint h = uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(salt) * 83492791u;
  h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
  return h;
}
float tuRand(ivec2 c, int salt) { return float(tuHash(c, salt) & 0xffffu) / 65535.0; }
// Value noise with \`cells\` cells across the field (repeating when periodic).
float tuNoise(vec2 pos, vec2 cells, int salt) {
  vec2 x = pos / uSize * cells;
  vec2 i = floor(x);
  vec2 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 n = ivec2(cells);
  ivec2 c0 = ivec2(i);
  ivec2 c1 = c0 + 1;
  if (uPeriodic == 1) { c0 = ((c0 % n) + n) % n; c1 = ((c1 % n) + n) % n; }
  float a = tuRand(c0, salt), b = tuRand(ivec2(c1.x, c0.y), salt);
  float c = tuRand(ivec2(c0.x, c1.y), salt), d = tuRand(c1, salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/** Start: faint white noise. */
const INIT = /* glsl */ `${HEADER}
uniform int uSeed;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  outColor = vec4(tuPack((tuRand(c, uSeed) - 0.5) * 0.2), 0.0, 1.0);
}
`;

/** Gradient → orientation tensor (cos 2φ, sin 2φ) × strength, strength. */
const TENSOR = /* glsl */ `${HEADER}
uniform sampler2D uAnalysis;
void main() {
  vec4 a = texelFetch(uAnalysis, ivec2(gl_FragCoord.xy), 0);
  vec2 g = (a.gb - 0.5) * 2.0;
  float m = clamp(length(g) * 3.0, 0.0, 1.0);
  float phi = atan(g.y, g.x);
  outColor = vec4(vec2(cos(2.0 * phi), sin(2.0 * phi)) * m * 0.5 + 0.5, m, 1.0);
}
`;

/** Plain Gaussian blur of RGBA values along one axis (linear filtering, spread-out taps). */
const BLUR = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float step = max(1.0, uSigma / 4.0);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int k = -12; k <= 12; k++) {
    float x = float(k) * step;
    float w = tuGauss(x, uSigma);
    sum += texture(uImage, uv + uDir * x / uSize) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}
`;

/**
 * Direction field: RG = (cos 2θ, sin 2θ) / 2 + 0.5 of the line direction θ,
 * B = how strongly lines align (0 = free maze), A = branching noise.
 */
const FLOW = /* glsl */ `${HEADER}
uniform float uOrder;
uniform float uDirection;
uniform float uWobble;
uniform float uFollow;
uniform int uHasImage;
uniform sampler2D uTensor;
uniform vec2 uUvPerTexel;
uniform vec2 uWobbleCells;
uniform vec2 uBranchCells;
uniform int uSeed;
void main() {
  vec2 pos = gl_FragCoord.xy;
  vec2 v = uOrder * vec2(cos(2.0 * uDirection), sin(2.0 * uDirection));
  if (uHasImage == 1) {
    vec4 t = texture(uTensor, pos * uUvPerTexel);
    vec2 g = (t.rg - 0.5) * 2.0;
    float m = t.b;
    // Along the edge: the gradient's orientation turned 90° (doubled angle: negated).
    vec2 tangent = m > 1e-3 ? -g / m : vec2(0.0);
    float coherence = m > 1e-3 ? length(g) / m : 0.0;
    v += uFollow * tangent * clamp(m * 4.0, 0.0, 1.0) * coherence * 2.0;
  }
  float strength = clamp(length(v), 0.0, 1.0);
  float theta = length(v) > 1e-4 ? 0.5 * atan(v.y, v.x) : uDirection;
  theta += uWobble * (tuNoise(pos, uWobbleCells, uSeed + 7) - 0.5) * 2.4;
  float branch = tuNoise(pos, uBranchCells, uSeed + 13) * 2.0 - 1.0;
  outColor = vec4(vec2(cos(2.0 * theta), sin(2.0 * theta)) * 0.5 + 0.5, strength, branch * 0.5 + 0.5);
}
`;

/** Horizontal part of both isotropic blurs: RG = short, BA = long. */
const ISO_X = /* glsl */ `${HEADER}
uniform sampler2D uU;
uniform float uSigma1;
uniform float uSigma2;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float a = 0.0, b = 0.0, wa = 0.0, wb = 0.0;
  for (int k = -16; k <= 16; k++) {
    float x = float(k);
    if (abs(x) > ceil(uSigma2 * 3.0)) continue;
    float u = tuAt(uU, c + ivec2(k, 0));
    float w1 = tuGauss(x, uSigma1), w2 = tuGauss(x, uSigma2);
    a += u * w1; wa += w1;
    b += u * w2; wb += w2;
  }
  outColor = vec4(tuPack(a / wa), tuPack(b / wb));
}
`;

/** Directional step: the blur difference across the line direction (RG). */
const ACROSS = /* glsl */ `${HEADER}
uniform sampler2D uU;
uniform sampler2D uFlow;
uniform float uSigma1;
uniform float uSigma2;
void main() {
  vec2 pos = gl_FragCoord.xy;
  vec4 fl = texelFetch(uFlow, ivec2(pos), 0);
  vec2 d2 = (fl.rg - 0.5) * 2.0;
  float theta = 0.5 * atan(d2.y, d2.x);
  vec2 n = vec2(-sin(theta), cos(theta));
  float a = 0.0, b = 0.0, wa = 0.0, wb = 0.0;
  for (int k = -16; k <= 16; k++) {
    float x = float(k);
    if (abs(x) > ceil(uSigma2 * 3.0)) continue;
    float u = tuBilinear(uU, pos + n * x);
    float w1 = tuGauss(x, uSigma1), w2 = tuGauss(x, uSigma2);
    a += u * w1; wa += w1;
    b += u * w2; wb += w2;
  }
  outColor = vec4(tuPack(a / wa - b / wb), 0.0, 1.0);
}
`;

/** The growth step: combines both, applies the bias, relaxes toward tanh. */
const UPDATE = /* glsl */ `${HEADER}
uniform sampler2D uU;
uniform sampler2D uIso;
uniform sampler2D uAcross;
uniform sampler2D uFlow;
uniform int uDirectional;
uniform float uSigma1;
uniform float uSigma2;
uniform float uSigmaAlong;
uniform float uGain;
uniform float uRelax;
uniform float uSpots;
uniform float uBranching;
void main() {
  vec2 pos = gl_FragCoord.xy;
  ivec2 c = ivec2(pos);
  float a = 0.0, b = 0.0, wa = 0.0, wb = 0.0;
  for (int k = -16; k <= 16; k++) {
    float x = float(k);
    if (abs(x) > ceil(uSigma2 * 3.0)) continue;
    float w1 = tuGauss(x, uSigma1), w2 = tuGauss(x, uSigma2);
    a += tuAt(uIso, c + ivec2(0, k)) * w1; wa += w1;
    b += tuAtBA(uIso, c + ivec2(0, k)) * w2; wb += w2;
  }
  float dog = a / wa - b / wb;
  vec4 fl = texelFetch(uFlow, c, 0);
  if (uDirectional == 1 && fl.b > 0.0) {
    // Smooth the across-step along the line, so lines stay continuous.
    vec2 d2 = (fl.rg - 0.5) * 2.0;
    float theta = 0.5 * atan(d2.y, d2.x);
    vec2 t = vec2(cos(theta), sin(theta));
    float s = 0.0, ws = 0.0;
    for (int k = -12; k <= 12; k++) {
      float x = float(k);
      if (abs(x) > ceil(uSigmaAlong * 3.0)) continue;
      float w = tuGauss(x, uSigmaAlong);
      s += tuBilinear(uAcross, pos + t * x) * w;
      ws += w;
    }
    dog = mix(dog, s / ws, fl.b);
  }
  float bias = -uSpots + uBranching * (fl.a - 0.5) * 2.0;
  float u = tuAt(uU, c);
  float target = tanh(uGain * dog + bias);
  outColor = vec4(tuPack(mix(u, target, uRelax)), 0.0, 1.0);
}
`;

/** Packed blur along one axis (for the final smoothing). */
const SMOOTH = /* glsl */ `${HEADER}
uniform sampler2D uU;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float s = 0.0, ws = 0.0;
  for (int k = -12; k <= 12; k++) {
    float x = float(k);
    if (abs(x) > ceil(uSigma * 3.0)) continue;
    float w = tuGauss(x, uSigma);
    s += tuAt(uU, c + ivec2(uDir) * k) * w;
    ws += w;
  }
  outColor = vec4(tuPack(s / ws), 0.0, 1.0);
}
`;

/**
 * Samples for measuring the distribution: one random point per stride × stride
 * block, read with the same bilinear interpolation the halftone uses (raw
 * texels would overstate the extremes, inking light tones too lightly).
 */
const SAMPLE = /* glsl */ `${HEADER}
uniform sampler2D uU;
uniform vec2 uStride;
uniform vec2 uFieldSize;
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec2 jitter = vec2(tuRand(cell, 101), tuRand(cell, 211));
  vec2 pos = (vec2(cell) + jitter) * uStride;
  // tuAt wraps/clamps by uSize, which here is this small target: use the field's size.
  vec2 q = min(pos, uFieldSize - 0.001) - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - floor(q);
  ivec2 n = ivec2(uFieldSize);
  ivec2 i0 = uPeriodic == 1 ? ((i % n) + n) % n : clamp(i, ivec2(0), n - 1);
  ivec2 i1 = uPeriodic == 1 ? (((i + 1) % n) + n) % n : clamp(i + 1, ivec2(0), n - 1);
  float a = tuUnpack(texelFetch(uU, i0, 0).rg), b = tuUnpack(texelFetch(uU, ivec2(i1.x, i0.y), 0).rg);
  float c = tuUnpack(texelFetch(uU, ivec2(i0.x, i1.y), 0).rg), d = tuUnpack(texelFetch(uU, i1, 0).rg);
  outColor = vec4(tuPack(mix(mix(a, b, f.x), mix(c, d, f.x), f.y)), 0.0, 1.0);
}
`;

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Decodes the packed value (see tuUnpack). */
function unpack(hi: number, lo: number): number {
  return ((hi * 256 + lo) / 65535 - 0.5) * 4;
}

/** Grows one field. Rejects with SupersededError if cancelled (its targets are freed). */
export async function buildTuringField(gpu: Gpu, b: TuringBuild): Promise<TuringField> {
  const { width: w, height: h } = b;
  const owned: Target[] = [];
  const make = (tw = w, th = h) => {
    const t = gpu.createTarget(tw, th, "coverage");
    owned.push(t);
    return t;
  };
  let lastYield = performance.now();
  const run = async (name: string, shader: string, target: Target, uniforms: Record<string, UniformValue>) => {
    const all = { uSize: [target.width, target.height], uPeriodic: b.periodic ? 1 : 0, ...uniforms };
    for (let y = 0; y < target.height; ) {
      if (b.isCancelled()) throw new SupersededError();
      const rows = bandRows(`turing|${name}`, target.width, target.height - y);
      const band = { y, height: rows };
      timedBand(gpu, target.framebuffer, `turing|${name}`, target.width * rows, () => gpu.draw(shader, target.framebuffer, target.width, target.height, all, band));
      y += rows;
      // Leave room for the page (and the preview) between bands.
      if (performance.now() - lastYield > 24) {
        await yieldNow();
        lastYield = performance.now();
      }
    }
  };

  try {
    const p = b.params;
    const S = b.samples;
    // Blur difference peaking at one wavelength: σ2 = 2σ1, peak at λ ≈ 6.54 σ1.
    const sigma1 = S / 6.54;
    const sigma2 = 2 * sigma1;
    const seed = (p.seed * 7919 + 17) & 0x7fffffff;
    const directional = p.order > 0.001 || (p.follow > 0.001 && !!b.orientation);
    // Noise cell counts: whole numbers of cells across a tile, so it repeats seamlessly.
    const cells = (wavelengths: number) => [Math.max(1, Math.round(w / (S * wavelengths))), Math.max(1, Math.round(h / (S * wavelengths)))];

    // Edge directions from the image, smoothed into a structure tensor.
    let tensor: Target | null = null;
    if (b.orientation && p.follow > 0.001) {
      const o = b.orientation;
      const aw = o.analysis.width;
      const ah = o.analysis.height;
      const t0 = make(aw, ah);
      const t1 = make(aw, ah);
      await run("tensor", TENSOR, t0, { uAnalysis: { texture: o.analysis.texture } });
      await run("blur", BLUR, t1, { uImage: { texture: t0.texture }, uDir: [1, 0], uSigma: o.sigma, uPeriodic: 0 });
      await run("blur", BLUR, t0, { uImage: { texture: t1.texture }, uDir: [0, 1], uSigma: o.sigma, uPeriodic: 0 });
      tensor = t0;
    }

    const flow = make();
    // Without image edges the tensor sampler still needs a texture (never the one being drawn into).
    const noTensor = tensor ?? make(1, 1);
    await run("flow", FLOW, flow, {
      uOrder: p.order,
      uDirection: p.direction,
      uWobble: p.wobble,
      uFollow: p.follow,
      uHasImage: tensor ? 1 : 0,
      uTensor: { texture: noTensor.texture },
      uUvPerTexel: b.orientation?.uvPerTexel ?? [0, 0],
      uWobbleCells: cells(4),
      uBranchCells: cells(1.5),
      uSeed: seed,
    });

    let u = make();
    let next = make();
    const iso = make();
    const across = directional ? make() : null;
    await run("init", INIT, u, { uSeed: seed });
    const step = {
      uSigma1: sigma1,
      uSigma2: sigma2,
      uSigmaAlong: S * 0.5,
      uGain: GAIN,
      uRelax: RELAX,
      uSpots: p.spots * 0.75,
      uBranching: p.branching * 0.6,
    };
    for (let i = 0; i < ITERATIONS; i++) {
      await run("isoX", ISO_X, iso, { uU: { texture: u.texture }, uSigma1: sigma1, uSigma2: sigma2 });
      if (across) await run("across", ACROSS, across, { uU: { texture: u.texture }, uFlow: { texture: flow.texture }, uSigma1: sigma1, uSigma2: sigma2 });
      await run("update", UPDATE, next, {
        ...step,
        uU: { texture: u.texture },
        uIso: { texture: iso.texture },
        uAcross: { texture: (across ?? iso).texture },
        uFlow: { texture: flow.texture },
        uDirectional: across ? 1 : 0,
      });
      [u, next] = [next, u];
      b.onProgress?.((i + 1) / ITERATIONS);
    }

    // A soft ridge along each line, so lines widen smoothly from their centers.
    const sigmaS = S / 6;
    await run("smooth", SMOOTH, next, { uU: { texture: u.texture }, uDir: [1, 0], uSigma: sigmaS });
    await run("smooth", SMOOTH, u, { uU: { texture: next.texture }, uDir: [0, 1], uSigma: sigmaS });

    // Distribution of the field → threshold per tone.
    const stride = Math.max(w, h) / 512;
    const sw = Math.max(1, Math.round(w / stride));
    const sh = Math.max(1, Math.round(h / stride));
    const sample = make(sw, sh);
    await run("sample", SAMPLE, sample, { uU: { texture: u.texture }, uStride: [w / sw, h / sh], uFieldSize: [w, h] });
    const bytes = gpu.read(sample);
    const values = new Float32Array(sw * sh);
    for (let i = 0; i < values.length; i++) values[i] = unpack(bytes[i * 4]!, bytes[i * 4 + 1]!);
    values.sort();
    const thresholds = new Float32Array(256);
    thresholds[0] = 1e9; // tone 0: nothing
    for (let t = 1; t < 256; t++) {
      // The darkest share t/255 of the area: the field's top values.
      const q = (1 - t / 255) * (values.length - 1);
      const lo = Math.floor(q);
      const hi = Math.min(values.length - 1, lo + 1);
      thresholds[t] = values[lo]! + (values[hi]! - values[lo]!) * (q - lo);
    }
    thresholds[255] = -1e9; // full tone: everything

    // Keep the field; free the rest.
    for (const t of owned) if (t !== u) gpu.deleteTarget(t);
    return { target: u, width: w, height: h, thresholds };
  } catch (err) {
    for (const t of owned) gpu.deleteTarget(t);
    throw err;
  }
}
