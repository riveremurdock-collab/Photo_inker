// Spectral ink model (see "Rendering Engine" in the outline).
//
// - Every ink and the paper is a 38-band reflectance curve, built from its
//   chosen color with the spectral.js method.
// - Riso ink is a transparent colored film. The chosen ink color means "this
//   ink printed solid on white paper", so its transmittance per band is
//   T = sqrt(R_ink / R_white): light passes through the film twice (in, then
//   back out after reflecting off the paper), so white paper × T² gives back
//   exactly the chosen color.
// - A stack of inks on paper: R = R_paper × T₁² × T₂² × … (band by band).
//   Yellow passes long wavelengths, blue passes short ones, and their product
//   keeps the green band in between, instead of turning olive.
// - Opacity a (0..1) makes an ink partly cover what is under it:
//   R_after = (1 − a) · R_before · T² + a · R_ink. Inks are applied in print
//   order, so order only matters for inks with opacity above 0.

import { hexToRgb, srgbToLinearChannel } from "../../util/color";
import { linearRgbToReflectance, reflectanceToLinearRgb, SPECTRAL_SIZE, type Spectrum } from "./spectral";

export interface InkSpec {
  hex: string;
  /** 0 = fully transparent film (normal riso ink), 1 = fully opaque. */
  opacity: number;
}

function hexToReflectance(hex: string): Spectrum {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  return linearRgbToReflectance(
    srgbToLinearChannel(rgb.r / 255),
    srgbToLinearChannel(rgb.g / 255),
    srgbToLinearChannel(rgb.b / 255),
  );
}

const WHITE = linearRgbToReflectance(1, 1, 1);

interface PreparedInk {
  /** Reflectance of the ink printed solid on white. */
  reflectance: Spectrum;
  /** Round-trip transmittance (T²) per band. */
  transmittance2: Spectrum;
  opacity: number;
}

function prepareInk(ink: InkSpec): PreparedInk {
  const reflectance = hexToReflectance(ink.hex);
  const transmittance2 = new Float64Array(SPECTRAL_SIZE);
  for (let i = 0; i < SPECTRAL_SIZE; i++) {
    transmittance2[i] = Math.min(1, reflectance[i]! / WHITE[i]!);
  }
  return { reflectance, transmittance2, opacity: Math.min(1, Math.max(0, ink.opacity)) };
}

/** Prints one ink (solid) over the given reflectance, in place. */
function printOver(r: Spectrum, ink: PreparedInk): void {
  const a = ink.opacity;
  for (let i = 0; i < SPECTRAL_SIZE; i++) {
    r[i] = (1 - a) * r[i]! * ink.transmittance2[i]! + a * ink.reflectance[i]!;
  }
}

/**
 * Colors of every solid ink combination (2ⁿ entries) in linear RGB.
 * Entry `mask` has ink i present when bit i is set; entry 0 is bare paper.
 * Values are not clipped: very saturated overlaps can fall outside sRGB and
 * are gamut-compressed at display time.
 */
export interface OverlapTable {
  inkCount: number;
  /** 2ⁿ × 3 floats (r, g, b). */
  colors: Float32Array;
}

export function buildOverlapTable(paperHex: string, inks: readonly InkSpec[]): OverlapTable {
  const paper = hexToReflectance(paperHex);
  const prepared = inks.map(prepareInk);
  const n = prepared.length;
  const colors = new Float32Array((1 << n) * 3);
  const r = new Float64Array(SPECTRAL_SIZE);

  for (let mask = 0; mask < 1 << n; mask++) {
    r.set(paper);
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) printOver(r, prepared[i]!);
    }
    const [lr, lg, lb] = reflectanceToLinearRgb(r);
    colors[mask * 3] = lr;
    colors[mask * 3 + 1] = lg;
    colors[mask * 3 + 2] = lb;
  }
  return { inkCount: n, colors };
}

/**
 * Color of a pixel with partial coverage (0..1 per ink), in linear RGB.
 *
 * Each ink independently covers a fraction of the pixel, so the pixel is an
 * area-weighted average of the solid combinations (Demichel weights). Because
 * converting a spectrum to color is linear, this equals running the spectral
 * model band by band on the averaged spectrum. It is also exactly what a
 * halftone looks like from a distance, which keeps tones consistent whether a
 * layer is smooth, halftoned, or zoomed out. The GPU shader does the same.
 */
export function mixCoverage(table: OverlapTable, coverage: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  const n = table.inkCount;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let w = 1;
    for (let i = 0; i < n; i++) {
      const c = coverage[i] ?? 0;
      w *= mask & (1 << i) ? c : 1 - c;
    }
    if (w === 0) continue;
    out[0] += w * table.colors[mask * 3]!;
    out[1] += w * table.colors[mask * 3 + 1]!;
    out[2] += w * table.colors[mask * 3 + 2]!;
  }
  return out;
}
