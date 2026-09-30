// Print simulation: misregistration, low-ink patches, specks and dot gain,
// applied to each ink layer before the layers are mixed (so flaws blend like
// real ink). One GLSL module serves the halftone compositor (preview), the
// export shaders and the mix pass (halftone None).
//
// - Preview: shows the effects in both modes.
// - Digital export: effects baked in.
// - Riso export: no effects; only dot gain compensation (Print mode, Export
//   setting), which pre-shrinks dots by the inverse of the dot gain curve. The
//   Print mode preview shows the compensated dots too, since that is what the
//   files will hold.
//
// Positions: output px measured from the image's corner (like the halftone
// code); patches and the coverage map use image px, so they sit in the same
// place at any output size.

import type { UniformValue } from "../engine/gl/gpu";
import type { ProjectSettings } from "../schema/sections";
import { createRng } from "../util/rng";

/** preview; digital (and the riso proof); riso layers; standard printer (no simulation). */
export type SimPurpose = "preview" | "digital" | "riso" | "standard";

const ABSORBENCY: Record<string, number> = { smooth: 0.6, uncoated: 1, recycled: 1.4 };
const SIDES: Record<string, number> = { top: 0, bottom: 1, left: 2, right: 3 };
const PATCH_SHAPES: Record<string, number> = { fractal: 1, streaks: 2, edge: 3 };

/** Whether any effect needs the blurred coverage map. */
export function simNeedsDensity(settings: ProjectSettings): boolean {
  return settings.printSim.enabled && (settings.simLowInk.on || (settings.simSpecks.on && settings.simSpecks.placement === "near"));
}

/** How far (image px) the simulation moves ink: margin for tiles and detail renders. */
export function simReach(settings: ProjectSettings, imageWidth: number, imageHeight: number, outScale: number): number {
  if (!settings.printSim.enabled) return 0;
  let out = 0;
  const m = settings.simMisreg;
  if (m.on) out += m.shift * Math.SQRT2 + ((m.rotation * Math.PI) / 180) * Math.hypot(imageWidth, imageHeight) * 0.5 * outScale;
  if (settings.simGain.on) out += 2;
  return out / outScale + 1;
}

export function simUniforms(
  settings: ProjectSettings,
  purpose: SimPurpose,
  imageWidth: number,
  imageHeight: number,
  outScale: number,
  density: WebGLTexture,
): Record<string, UniformValue> {
  const print = settings.upload.mode === "print";
  const riso = print && settings.export.printTarget === "riso";
  // A standard printer page never gets the simulation; neither does its preview.
  const on = settings.printSim.enabled && (purpose === "digital" || (purpose === "preview" && !(print && !riso)));
  // Compensation shapes riso layers, and the preview of them.
  const compensate = riso && settings.export.gainCompensation && (purpose === "riso" || purpose === "preview");
  const g = settings.simGain;
  const gainAmount = (i: number) => ((g.amount[i] ?? 0) / 100) * (ABSORBENCY[g.paper] ?? 1);
  const vec4 = (f: (i: number) => number) => [0, 1, 2, 3].map(f);

  const m = settings.simMisreg;
  const mrng = createRng(m.seed * 9973 + 5);
  const shift: number[] = [];
  const rot: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = mrng() * 2 * Math.PI;
    const r = Math.sqrt(mrng()) * m.shift;
    shift.push(on && m.on ? r * Math.cos(a) : 0, on && m.on ? r * Math.sin(a) : 0);
    rot.push(on && m.on ? (mrng() * 2 - 1) * ((m.rotation * Math.PI) / 180) : 0);
  }

  const l = settings.simLowInk;
  const short = Math.min(imageWidth, imageHeight);
  const prng = createRng(l.seed * 7919 + 3);
  const shared = [prng() * 1000, prng() * 1000];
  const patchOffset: number[] = [];
  for (let i = 0; i < 4; i++) patchOffset.push(...(l.shared ? shared : [prng() * 1000, prng() * 1000]));

  const s = settings.simSpecks;
  const minSize = Math.min(s.minSize, s.maxSize);
  const maxSize = Math.max(s.minSize, s.maxSize);
  const cell = Math.max(24, maxSize * 4);

  return {
    uSimOn: on ? 1 : 0,
    uSimShift: shift,
    uSimRot: rot,
    uSimCenter: [(imageWidth * outScale) / 2, (imageHeight * outScale) / 2],
    uSimGain: vec4((i) => (on && g.on ? gainAmount(i) : 0)),
    uSimComp: vec4((i) => (compensate ? gainAmount(i) : 0)),
    uSimCurve: g.curve === "midtone" ? 1 : 0,
    uSimRough: on && g.on ? (g.roughness / 100) * 1.5 : 0,

    uSimPatch: on && l.on && l.intensity > 0 ? (PATCH_SHAPES[l.shape] ?? 1) : 0,
    uSimPatchIntensity: l.intensity / 100,
    uSimPatchSize: Math.max(1, (l.size / 100) * short),
    uSimOctaves: Math.round(l.detail),
    uSimPersistence: 0.3 + 0.4 * (l.roughness / 100),
    uSimStreakDir: (l.direction * Math.PI) / 180,
    uSimStreakLen: l.streakLength,
    uSimStreakFreq: l.frequency,
    uSimEdgeSide: SIDES[l.side] ?? 3,
    uSimEdgeFalloff: Math.max(1, (l.falloff / 100) * (l.side === "top" || l.side === "bottom" ? imageHeight : imageWidth)),
    uSimInfluence: l.influence / 100,
    uSimSoftness: l.softness / 100,
    uSimPatchOffset: patchOffset,
    uSimDensity: { texture: density },
    uSimImageSize: [imageWidth, imageHeight],
    uSimOutScale: outScale,

    uSimSpecks: on && s.on && s.density > 0 ? 1 : 0,
    uSimSpeckInk: vec4((i) => (s.ink[i] ? 1 : 0)),
    uSimSpeckCell: cell,
    uSimSpeckProb: Math.min(1, (s.density * cell * cell) / 1e6),
    uSimSpeckMin: minSize,
    uSimSpeckMax: maxSize,
    uSimSpeckExtra: s.extra / 100,
    uSimSpeckClump: s.clumping / 100,
    uSimSpeckNear: s.placement === "near" ? 1 : 0,
    uSimSpeckOpacity: s.opacity / 100,
    uSimSeed: s.seed & 0xffff,
  };
}

/**
 * The print simulation GLSL. Defines simWarp, simTone, simPatchLost, simApply
 * (binary ink) and simSpeck; needs nothing before it.
 *
 * With effects off (always for riso layers, and whenever Simulate printing is
 * off), a small variant is compiled instead: everything is a pass-through
 * except dot gain compensation. The full code is large, and software GPUs
 * run noticeably slower with it even when its branches are never taken.
 */
export function glslPrintSim(effects: boolean): string {
  return effects ? GLSL_PRINTSIM_FULL : GLSL_PRINTSIM_OFF;
}

const GLSL_GAIN = /* glsl */ `
float simGainCurve(float c, float a) { return uSimCurve == 1 ? c + 4.0 * a * c * (1.0 - c) : min(1.0, c * (1.0 + 2.0 * a)); }
float simGainInverse(float y, float a) {
  if (a <= 0.0) return y;
  if (uSimCurve == 1) {
    float b = 1.0 + 4.0 * a;
    return (b - sqrt(max(0.0, b * b - 16.0 * a * y))) / (8.0 * a);
  }
  return y / (1.0 + 2.0 * a);
}
`;

const GLSL_PRINTSIM_OFF = /* glsl */ `
uniform int uSimOn;
uniform vec4 uSimComp;
uniform int uSimCurve;
uniform vec2 uSimImageSize;
uniform float uSimOutScale;
${GLSL_GAIN}
vec2 simWarp(int ink, vec2 op, bool ragged) { return op; }
float simTone(int ink, float c) { return clamp(simGainInverse(c, uSimComp[ink]), 0.0, 1.0); }
float simPatchLost(int ink, vec2 op) { return 0.0; }
int simSpeck(int ink, vec2 op) { return 0; }
bool simApply(int ink, vec2 op, float lost, bool on) { return on; }
`;

const GLSL_PRINTSIM_FULL = /* glsl */ `
uniform int uSimOn;
uniform vec2 uSimShift[4];
uniform vec4 uSimRot;
uniform vec2 uSimCenter;
uniform vec4 uSimGain;
uniform vec4 uSimComp;
uniform int uSimCurve;          // 0 uniform, 1 midtone-weighted
uniform float uSimRough;        // output px
uniform int uSimPatch;          // 0 off, 1 blotches, 2 streaks, 3 edge fade
uniform float uSimPatchIntensity;
uniform float uSimPatchSize;    // image px
uniform int uSimOctaves;
uniform float uSimPersistence;
uniform float uSimStreakDir;
uniform float uSimStreakLen;
uniform float uSimStreakFreq;
uniform int uSimEdgeSide;
uniform float uSimEdgeFalloff;  // image px
uniform float uSimInfluence;
uniform float uSimSoftness;
uniform vec2 uSimPatchOffset[4];
uniform sampler2D uSimDensity;  // blurred ink coverage, whole image
uniform vec2 uSimImageSize;
uniform float uSimOutScale;
uniform int uSimSpecks;
uniform vec4 uSimSpeckInk;
uniform float uSimSpeckCell;
uniform float uSimSpeckProb;
uniform float uSimSpeckMin;
uniform float uSimSpeckMax;
uniform float uSimSpeckExtra;
uniform float uSimSpeckClump;
uniform int uSimSpeckNear;
uniform float uSimSpeckOpacity;
uniform int uSimSeed;

uint simHash(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
float simRnd(uint v) { return float(simHash(v) >> 8u) / 16777216.0; }
// Coordinates are offset to stay positive before the int → uint conversion.
uint simKey(ivec2 c, int k) {
  uvec2 u = uvec2(c + 1048576);
  return simHash(u.x * 0x8da6b343u ^ u.y * 0xd8163841u ^ uint(k) * 0xcb1ab31fu);
}
float simNoise(vec2 x, int k) {
  vec2 i = floor(x);
  vec2 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = simRnd(simKey(c, k)), b = simRnd(simKey(c + ivec2(1, 0), k));
  float d = simRnd(simKey(c + ivec2(0, 1), k)), e = simRnd(simKey(c + ivec2(1, 1), k));
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
// Fractal noise. Each octave is rotated and the input lightly warped, so the
// value noise's square grid doesn't show as blocky, axis-aligned blotches.
float simFbm(vec2 x, int octaves, float persistence, int k) {
  const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);
  x = ROT * x;
  x += (vec2(simNoise(x * 0.7, k + 50), simNoise(x * 0.7 + 5.2, k + 60)) - 0.5) * 1.2;
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 6; o++) {
    if (o >= octaves) break;
    sum += amp * simNoise(x, k + o * 31);
    norm += amp;
    amp *= persistence;
    x = ROT * x * 2.03 + 17.1;
  }
  return sum / norm;
}

// Where in its own layer an ink is read for output position op (misregistration, ragged edges).
vec2 simWarp(int ink, vec2 op, bool ragged) {
  if (uSimOn == 0) return op;
  vec2 d = op - uSimCenter;
  float c = cos(uSimRot[ink]), s = sin(uSimRot[ink]);
  vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y) + uSimCenter - uSimShift[ink];
  if (ragged && uSimRough > 0.0) {
    q += (vec2(simNoise(op * 0.6, 800 + ink), simNoise(op * 0.6 + 17.3, 900 + ink)) - 0.5) * 2.0 * uSimRough;
  }
  return q;
}

${GLSL_GAIN}
// Ink tone after compensation (pre-shrinking) and simulated dot gain.
float simTone(int ink, float c) {
  c = simGainInverse(c, uSimComp[ink]);
  if (uSimOn == 1) c = simGainCurve(c, uSimGain[ink]);
  return clamp(c, 0.0, 1.0);
}

float simDensity(int ink, vec2 ip) {
  return texture(uSimDensity, clamp(ip / uSimImageSize, vec2(0.0), vec2(1.0)))[ink];
}

// Share of ink lost to a low-ink patch around op (0 = none). Varies slowly.
float simPatchLost(int ink, vec2 op) {
  if (uSimOn == 0 || uSimPatch == 0) return 0.0;
  vec2 ip = op / uSimOutScale;
  vec2 u = ip / uSimPatchSize + uSimPatchOffset[ink];
  float v;
  if (uSimPatch == 1) {
    v = simFbm(u, uSimOctaves, uSimPersistence, 101);
  } else if (uSimPatch == 2) {
    float c = cos(uSimStreakDir), s = sin(uSimStreakDir);
    vec2 r = vec2(c * u.x + s * u.y, -s * u.x + c * u.y); // r.x along the paper feed
    v = simFbm(vec2(r.x / uSimStreakLen, r.y * uSimStreakFreq), 3, 0.5, 202);
  } else {
    float d = uSimEdgeSide == 0 ? ip.y : uSimEdgeSide == 1 ? uSimImageSize.y - ip.y : uSimEdgeSide == 2 ? ip.x : uSimImageSize.x - ip.x;
    v = (1.0 - clamp(d / uSimEdgeFalloff, 0.0, 1.0)) * (0.75 + 0.5 * simFbm(u * 2.0, 3, 0.5, 303));
  }
  // Heavily inked areas run short first.
  v *= mix(1.0, smoothstep(0.1, 0.8, simDensity(ink, ip)), uSimInfluence);
  float soft = 0.02 + uSimSoftness * 0.25;
  return uSimPatchIntensity * smoothstep(0.55 - soft, 0.55 + soft, v);
}

// A speck at op: 1 = extra ink, -1 = pinhole, 0 = none.
int simSpeck(int ink, vec2 op) {
  if (uSimOn == 0 || uSimSpecks == 0 || uSimSpeckInk[ink] < 0.5) return 0;
  float S = uSimSpeckCell;
  vec2 cellf = floor(op / S);
  ivec2 cell = ivec2(cellf);
  uint h = simKey(cell, 500 + ink * 7 + uSimSeed * 13);
  float p = uSimSpeckProb;
  if (uSimSpeckClump > 0.0) {
    float n = simNoise(cellf / 5.0, 600 + ink + uSimSeed);
    p *= mix(1.0, 4.0 * n * n * n, uSimSpeckClump);
  }
  if (simRnd(h) >= p) return 0;
  float r = mix(uSimSpeckMin, uSimSpeckMax, simRnd(h + 1u)) * 0.5;
  vec2 c = cellf * S + r + vec2(simRnd(h + 2u), simRnd(h + 3u)) * max(0.0, S - 2.0 * r);
  vec2 d = op - c;
  float dd = dot(d, d);
  if (dd > r * r * 1.8) return 0;
  float a = dd < 1e-6 ? 0.0 : atan(d.y, d.x);
  float rr = r * (1.0 + 0.22 * sin(3.0 * a + 6.2832 * simRnd(h + 4u)) + 0.1 * sin(7.0 * a + 6.2832 * simRnd(h + 5u)));
  if (dd > rr * rr) return 0;
  if (uSimSpeckOpacity < 1.0 && simRnd(simKey(ivec2(floor(op)), 700 + ink)) > uSimSpeckOpacity) return 0;
  bool extra = simRnd(h + 6u) < uSimSpeckExtra;
  if (extra && uSimSpeckNear == 1 && simDensity(ink, op / uSimOutScale) < 0.05) return 0;
  return extra ? 1 : -1;
}

// Applies low-ink grain and specks to one ink's on/off at op (its warped position).
bool simApply(int ink, vec2 op, float lost, bool on) {
  if (uSimOn == 0) return on;
  if (on && lost > 0.0 && simRnd(simKey(ivec2(floor(op)), 400 + ink + uSimSeed * 3)) < lost) on = false;
  int sp = simSpeck(ink, op);
  if (sp == 1) on = true;
  else if (sp == -1) on = false;
  return on;
}
`;
